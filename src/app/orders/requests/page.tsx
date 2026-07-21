'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { X, CheckCircle2, Clock, Layers, MessageCircleQuestion, CircleX, type LucideIcon } from 'lucide-react'
import { StatusTabs, accentFromBadge, BRAND_TAB_ACCENT, type TabAccent } from '@/components/ui/StatusTabs'
import { notifyOrders } from '@/lib/notify'
import { formatINR } from '@/lib/currency'
import { orderNumberErrorMessage } from '@/lib/orderNumbering'
import { FinanceModal, RequestModalShell } from '@/app/finance/components/FinanceModalShell'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'

// ── Types ─────────────────────────────────────────────────────────────────────

type OrderRequest = {
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
  clarification_note: string | null
  rejection_reason: string | null
  created_at: string
  // Always null for every row this page loads — the list query excludes
  // status = 'converted', and order_requests_converted_consistency (20260680)
  // makes the two equivalent. Kept on the type so the permission guards below
  // still state the full rule rather than relying on that equivalence.
  converted_order_id: string | null
}

// The project's existing requester rule (order_requests_requester_select /
// _insert, and resubmit_order_request): the requester is created_by OR
// requested_by. assigned_to is deliberately NOT an owner.
function isPermittedRequester(r: OrderRequest, userId: string): boolean {
  return r.created_by === userId || r.requested_by === userId
}

// The statuses in which a request is still the requester's to work on: edit it,
// and add/link/unlink the payments they submitted. Exactly the set
// link_finance_payment_to_order_request accepts server-side (20260699).
// 'converted' is absent on purpose — a converted request is read-only for its
// requester, enforced by the order_requests_guard_converted trigger, not by
// this constant.
const REQUESTER_OPEN_STATUSES = ['submitted', 'needs_clarification', 'rejected']

// May this viewer still change the request itself? Admins always may; the
// requester only while it is open. Mirrors, and never widens, what
// order_requests_requester_update / resubmit / reapply already permit.
function canEditRequest(r: OrderRequest, userId: string, isAdmin: boolean): boolean {
  if (r.status === 'converted' || r.converted_order_id) return false
  return isAdmin || (isPermittedRequester(r, userId) && REQUESTER_OPEN_STATUSES.includes(r.status))
}

// May this viewer attach or detach payments on this request? Same rule, but
// stated separately because it maps to a different server-side gate (the two
// linkage RPCs) and must never drift from it.
function canManagePayments(r: OrderRequest, userId: string, isAdmin: boolean): boolean {
  if (r.converted_order_id || !REQUESTER_OPEN_STATUSES.includes(r.status)) return false
  return isAdmin || isPermittedRequester(r, userId)
}

// A payment attached to this request via order_request_id. Non-admins see
// these through finance_payment_requests_order_request_owner_select (20260699),
// which exposes only payments already attached to a request they own.
type LinkedPayment = {
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

// Structured result returned by convert_order_request_to_order().
type ConvertResult = {
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
type EligiblePayment = {
  id: string
  request_number: string
  client_name: string
  amount: number
  payment_date: string
  proof_note: string | null
  submitted_by_name?: string
}

// A suspense payment eligible to be parked on THIS Order Request via
// link_finance_payment_to_order_request (20260698) — same eligibility
// Finance's own Link modal enforces: approved_unlinked, no order, no other
// request already holding it.
type SuspensePayment = {
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
type AssigneeOption = { id: string; full_name: string; source: 'sales' | 'override' }

type StatusFilter = 'pending' | 'needs_clarification' | 'rejected' | 'all'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  submitted:           { label: 'Submitted',           bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  needs_clarification: { label: 'Needs Clarification',  bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' },
  rejected:            { label: 'Rejected',             bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

// This module lists only requests that still need someone to act on them, so
// 'converted' has no tab: conversion is the exit from Order Requests, and the
// converted row is excluded by loadRequests' own query, not merely by a tab
// filter. The row itself is never deleted — it stays in public.order_requests
// permanently, and is reached through the Confirmed Order's Source Request
// provenance (orders.source_order_request_id, 20260701).
//
// "Pending" is the submitted-and-awaiting-review tab. Its key is 'pending' —
// label and key say the same thing, and LEGACY_TAB_KEYS below normalizes the
// old 'active' spelling so no second permanent key survives.
//
// Each tab's accent comes from the STATUS_META badge its rows already wear, so a
// request reads the same colour in the strip, the table, and the detail modal.
// 'all' is the only tab with no row equivalent; it takes the BOE brand accent.
const STATUS_TABS: { key: StatusFilter; label: string; match: (s: string) => boolean; Icon: LucideIcon; accent: TabAccent }[] = [
  { key: 'pending',             label: 'Pending',             match: s => s === 'submitted',           Icon: Clock,                 accent: accentFromBadge(STATUS_META.submitted) },
  { key: 'needs_clarification', label: 'Needs Clarification', match: s => s === 'needs_clarification', Icon: MessageCircleQuestion, accent: accentFromBadge(STATUS_META.needs_clarification) },
  { key: 'rejected',            label: 'Rejected',            match: s => s === 'rejected',            Icon: CircleX,               accent: accentFromBadge(STATUS_META.rejected) },
  { key: 'all',                 label: 'All',                 match: () => true,                       Icon: Layers,                accent: BRAND_TAB_ACCENT },
]

const LEAD_SOURCE_OPTIONS = [
  { value: 'reference',       label: 'Reference' },
  { value: 'repeat_customer', label: 'Repeat Customer' },
  { value: 'whatsapp',        label: 'WhatsApp' },
  { value: 'instagram',       label: 'Instagram' },
  { value: 'website',         label: 'Website' },
]

// Display labels for suspense-payment rows in the link panel. Mirror the
// Finance Received Payments page's maps exactly (finance/received/page.tsx) so
// the same stored value reads identically on both surfaces.
const PAYMENT_MODE_LABEL: Record<string, string> = {
  bank_transfer: 'Bank Transfer',
  cash:          'Cash',
  upi:           'UPI',
  cheque:        'Cheque',
  other:         'Other',
}

const RECEIVED_IN_LABEL: Record<string, string> = {
  company_account: 'HDFC',
  cash_in_hand:    'Paytm',
  savings_account: 'Canara',
  other:           'PNB',
}

// Payment-status badges for the Payments section. Same labels and colours the
// Finance Received Payments page uses, so one payment reads identically on both
// surfaces. A payment parked on a request stays approved_unlinked in the
// database but is shown with its own label — see paymentStatusMeta below.
const PAYMENT_STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_approval:    { label: 'Pending',             bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  approved_unlinked:   { label: 'Order No. Pending',   bg: '#FFF7ED', color: '#92400E', border: '#FED7AA' },
  approved_linked:     { label: 'Received Payment',    bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  needs_clarification: { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  rejected:            { label: 'Rejected',            bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

function paymentStatusMeta(p: LinkedPayment) {
  if (p.status === 'approved_unlinked' && p.order_request_id) {
    return { label: 'Awaiting Order Confirmation', bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' }
  }
  return PAYMENT_STATUS_META[p.status] ?? { label: p.status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Maps an incoming ?tab= value (e.g. from the Admin Action Queue) to a known
// StatusFilter, defaulting to 'pending' for anything missing or unrecognized —
// never throws on an invalid/stale deep link.
const STATUS_FILTER_KEYS: StatusFilter[] = ['pending', 'needs_clarification', 'rejected', 'all']

// Retired spellings, translated on the way in. 'active' was this tab's key
// before it was renamed to match its "Pending" label; bookmarks, notification
// links and pasted URLs still carry it. Normalized rather than kept alive as a
// second accepted key: the page rewrites the URL to the canonical spelling (see
// the deep-link effect), so an old link works exactly once more and then stops
// existing. Anything not listed here still falls through to the default.
const LEGACY_TAB_KEYS: Record<string, StatusFilter> = { active: 'pending' }

function parseStatusFilter(value: string | null): StatusFilter {
  const raw = value ?? ''
  if ((STATUS_FILTER_KEYS as string[]).includes(raw)) return raw as StatusFilter
  return LEGACY_TAB_KEYS[raw] ?? 'pending'
}

// Numeric columns can surface as strings depending on the driver; coerce
// defensively so a stored value never renders as "₹NaN". Genuine zero renders
// as ₹0; only null/undefined/empty/unparseable become "—".
function fmtAmount(n: number | string | null | undefined) {
  if (n == null || n === '') return '—'
  const num = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(num)) return '—'
  return formatINR(num)
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Advance-received derivation ───────────────────────────────────────────────
// A payment reaches a request through exactly one of two linkages, never both
// (finance_payment_requests_one_link_target, 20260698):
//   - before conversion, order_request_id points at the request itself;
//   - conversion moves the payment to order_id in the same statement, and the
//     request keeps converted_order_id pointing at that Order.
// Only the first case can appear here: this module lists open requests only, so
// every row is pre-conversion and the parked-payment aggregate is the whole
// picture. The post-conversion figure lives on the Order detail page, which
// owns the official Order value that anchors its percentage. Client-name
// matching is display-only guidance elsewhere in this file and is never a
// financial rule: a request with no linked payment reports "not linked", never
// a confirmed ₹0.
//
// The aggregate is read with the viewer's own RLS. Every request a non-admin
// can see is one they own (order_requests_requester_select), and
// finance_payment_requests_order_request_owner_select (20260699) exposes every
// payment attached to a request they own — so the sums are complete for every
// row on screen, for admins and requesters alike. `restricted` is therefore no
// longer a role verdict: it means the aggregate query itself failed, and it
// renders as "—" rather than as a false ₹0.
//
// `request_linked` carries the parked total and count; a percentage is
// deliberately withheld, because until conversion there is no official Order
// value to use as a denominator.
type RequestLinkAgg = { total: number; count: number }
type AdvanceInfo =
  | { kind: 'not_linked' }
  | { kind: 'restricted' }
  | { kind: 'request_linked'; received: number; count: number }

function getAdvanceInfo(
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

// A light inline "Link payment" / "Link another" action for the table cell.
// stopPropagation keeps the row's own open-details click from also firing.
function LinkPaymentAction({ label, onLink }: { label: string; onLink: () => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onLink() }}
      style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        font: 'inherit', fontSize: '11px', fontWeight: 600, color: colors.blue,
        textDecoration: 'underline', textUnderlineOffset: '2px',
      }}
    >
      {label}
    </button>
  )
}

// Compact two-line advance indicator for the table. `canLink` (admin or the
// request's own requester) enables the request-side link actions; the numbers
// themselves come from getAdvanceInfo, never recomputed here.
function AdvanceCell({ info, canLink, onLink }: { info: AdvanceInfo; canLink: boolean; onLink: () => void }) {
  if (info.kind === 'not_linked') {
    return canLink
      ? <LinkPaymentAction label="Link payment" onLink={onLink} />
      : <span style={{ fontSize: '12px', color: colors.muted }}>Not linked</span>
  }
  if (info.kind === 'restricted') {
    return <span style={{ color: colors.muted }}>—</span>
  }
  const { received, count } = info
  return (
    <div>
      <div style={{ fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
        {formatINR(received)}
      </div>
      <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span>{count} payment{count !== 1 ? 's' : ''} linked</span>
        {canLink && (
          <>
            <span aria-hidden="true">·</span>
            <LinkPaymentAction label="Link another" onLink={onLink} />
          </>
        )}
      </div>
    </div>
  )
}

// There is no stable shared client ID between finance_payment_requests and
// order_requests (both carry only a free-text client_name) — this is
// deterministic normalized-text comparison only, used for sorting and the
// mismatch warning below. It is display guidance, never a hard filter: a
// mismatched payment stays fully selectable, and the RPC does not validate
// client match at all.
function normalizeClientName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// ── Request details modal ─────────────────────────────────────────────────────
// Same visual system as the Finance DetailsModal: the shared RequestModalShell
// (sticky header with request number / client / submitted line / status badge)
// plus a full-width commercial summary strip and a pinned action bar. Every
// workflow action (Convert, Clarify, Reject, Resubmit, Reapply, Open Order)
// lives here now — the table has no action buttons. Visibility conditions are
// identical to the ones the table buttons used; the handlers and confirmation
// modals are the existing ones, invoked via callbacks.

// Compact horizontal label–value row for the details panels: muted uppercase
// label on the left, darker value on the right, hairline separator between
// rows (suppressed on the last row so panel height tracks content exactly).
function DetailRow({ label, value, muted, last }: { label: string; value: string; muted?: boolean; last?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '16px',
      padding: '9px 0', borderBottom: last ? 'none' : `1px solid ${colors.border}`,
    }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: '14px', color: muted ? colors.muted : colors.primary, textAlign: 'right', wordBreak: 'break-word', minWidth: 0, lineHeight: 1.4 }}>
        {value}
      </span>
    </div>
  )
}

// Compact uppercase section label, as used in the Finance details modal.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {children}
    </div>
  )
}

// One metric group inside the commercial summary panel. Groups are separated
// by the panel's 1px divider grid, not by per-group borders — the four figures
// read as a single surface. Unavailable states ("Not linked", "—") render at
// body weight in muted text so they never masquerade as financial figures.
function MetricGroup({ label, value, note, valueMuted, bar, action }: {
  label: string
  value: string
  note?: string
  valueMuted?: boolean
  bar?: { pct: number; tone: string }
  action?: React.ReactNode
}) {
  return (
    <div style={{
      background: colors.base, padding: '14px 16px', minWidth: 0,
      display: 'flex', flexDirection: 'column', gap: '5px',
    }}>
      <span style={{ fontSize: '10.5px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span style={{
        fontSize: valueMuted ? '14px' : '21px',
        fontWeight: valueMuted ? 500 : 700,
        lineHeight: valueMuted ? '25px' : 1.2,
        color: valueMuted ? colors.muted : colors.primary,
        fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word',
      }}>
        {value}
      </span>
      {bar && (
        <div aria-hidden="true" style={{ height: '4px', borderRadius: '2px', background: colors.float, overflow: 'hidden', maxWidth: '160px' }}>
          <div style={{ width: `${Math.min(bar.pct, 100)}%`, height: '100%', background: bar.tone }} />
        </div>
      )}
      {note && <span style={{ fontSize: '11.5px', color: colors.muted }}>{note}</span>}
      {action && <div style={{ marginTop: '2px' }}>{action}</div>}
    </div>
  )
}

// Small underlined "Link payment" / "Link another" trigger used inside the
// details-modal summary. Expands the payment-link panel below; never a popup.
function SummaryLinkButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        font: 'inherit', fontSize: '12px', fontWeight: 600, color: colors.blue,
        textDecoration: 'underline', textUnderlineOffset: '2px',
      }}
    >
      {label}
    </button>
  )
}

// ── Payment-link panel (order-first workflow) ─────────────────────────────────
// Lives at the bottom of RequestDetailsModal. Reuses the SAME guarded backend
// path Finance's Link modal uses — link_finance_payment_to_order_request
// (20260698) — never a direct column update and never a second RPC. Suspense
// eligibility mirrors Finance exactly: approved_unlinked, order_id null,
// order_request_id null. Nothing loads until the admin explicitly searches or
// views all.

const SUSPENSE_PAGE_SIZE = 10

// Message shown when the payment itself is no longer a linkable suspense row.
// Named so the caller can also decide to drop it from the visible results.
const PAYMENT_ALREADY_LINKED_MSG = 'This payment has already been linked.'

// Map a link RPC failure (link_finance_payment_to_order_request, 20260698) to a
// specific, honest line — never raw Postgres text, and NOT collapsing every
// error into "already linked". `stale` marks the payment-no-longer-eligible
// case so the caller removes it from the list; other failures leave it in
// place for a retry.
function friendlyLinkError(message: string | undefined): { text: string; stale: boolean } {
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
function buildSuspenseSearchConds(raw: string): string[] {
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

function RequestPaymentLinkPanel({
  request,
  supabase,
  searchInputRef,
  ownOnlyUserId,
  onLinked,
}: {
  request: OrderRequest
  supabase: ReturnType<typeof createClient>
  searchInputRef: React.RefObject<HTMLInputElement | null>
  // Non-null for a non-admin: the panel then queries only payments THIS user
  // submitted, so a requester can never page through the company's suspense
  // ledger. finance_payment_requests RLS already limits them to their own
  // submissions (plus payments already attached to a request they own, which
  // are excluded here by the order_request_id IS NULL filter) — this filter is
  // the visible, intentional half of the same rule, not its only enforcement.
  ownOnlyUserId: string | null
  onLinked: (payment: SuspensePayment) => void
}) {
  const [query,     setQuery]     = useState('')
  // The term that actually produced the current search results — Show more
  // paginates against THIS, not the live input box, so editing the box after a
  // search never silently re-filters the loaded page.
  const [searchedTerm, setSearchedTerm] = useState('')
  const [mode,      setMode]      = useState<'search' | 'all' | null>(null)
  const [limit,     setLimit]     = useState(SUSPENSE_PAGE_SIZE)
  const [results,   setResults]   = useState<SuspensePayment[]>([])
  const [hasMore,   setHasMore]   = useState(false)
  const [searching, setSearching] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  // Guidance shown when a Search term has no usable token after sanitisation
  // (e.g. "₹", ",,,", "()", spaces). Distinct from `error`; never triggers a query.
  const [inputNotice, setInputNotice] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<SuspensePayment | null>(null)
  const [linking,   setLinking]   = useState(false)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRow = (p: any): SuspensePayment => ({
    id: p.id,
    request_number: p.request_number,
    client_name: p.client_name,
    amount: Number(p.amount),
    payment_date: p.payment_date,
    payment_mode: p.payment_mode,
    received_in: p.received_in,
    proof_note: p.proof_note ?? null,
    sales_note: p.sales_note ?? null,
  })

  // One eligibility filter, shared by search and view-all: exactly the rows
  // Finance treats as suspense. Fetches limit+1 to detect "Show more" without
  // a second count query.
  // `searchConds` is required for a 'search' fetch and ignored for 'all'. A
  // 'search' fetch with no conditions is refused outright, so a Search action
  // can never silently degrade into an unfiltered View-all query.
  const runFetch = async (m: 'search' | 'all', lim: number, searchConds?: string[]) => {
    if (m === 'search' && (!searchConds || searchConds.length === 0)) return

    setSearching(true)
    setError(null)
    let q = supabase
      .from('finance_payment_requests')
      .select('id, request_number, client_name, amount, payment_date, payment_mode, received_in, proof_note, sales_note')
      .eq('status', 'approved_unlinked')
      .is('order_id', null)
      .is('order_request_id', null)
      // Newest received first; id is a deterministic tiebreak so same-date rows
      // keep a stable order across "Show more" refetches (no drift/duplication).
      .order('payment_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(lim + 1)

    // Non-admin: own submissions only, applied to search AND view-all alike so
    // neither path can widen into the full ledger.
    if (ownOnlyUserId) q = q.eq('submitted_by', ownOnlyUserId)

    // View-all applies only the eligibility filter above; search adds the
    // pre-built .or() conditions (never rebuilt from the live input here).
    if (m === 'search' && searchConds) q = q.or(searchConds.join(','))

    const { data, error: dbErr } = await q
    if (dbErr) {
      setResults([])
      setHasMore(false)
      setError('Could not load suspense payments. Please try again.')
      setSearching(false)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (data ?? []) as any[]
    setHasMore(rows.length > lim)
    setResults(rows.slice(0, lim).map(mapRow))
    setSearching(false)
  }

  const handleSearch = () => {
    const raw = query.trim()
    const conds = buildSuspenseSearchConds(raw)
    // Nothing usable survived sanitisation ("₹", ",,,", "()", spaces): show
    // guidance and run no query — this is NOT a View-all.
    if (conds.length === 0) {
      setInputNotice('Enter a payment reference, payer, amount or date.')
      setError(null)
      setConfirmTarget(null)
      setMode(null)
      setResults([])
      setHasMore(false)
      return
    }
    setInputNotice(null)
    setSearchedTerm(raw)
    setMode('search')
    setLimit(SUSPENSE_PAGE_SIZE)
    setConfirmTarget(null)
    runFetch('search', SUSPENSE_PAGE_SIZE, conds)
  }

  const handleViewAll = () => {
    setInputNotice(null)
    setMode('all')
    setLimit(SUSPENSE_PAGE_SIZE)
    setConfirmTarget(null)
    runFetch('all', SUSPENSE_PAGE_SIZE)
  }

  const handleShowMore = () => {
    if (!mode) return
    const next = limit + SUSPENSE_PAGE_SIZE
    setLimit(next)
    // Show more preserves the mode and, in search mode, the ORIGINAL executed
    // term (searchedTerm) — not whatever is currently typed in the box.
    if (mode === 'search') runFetch('search', next, buildSuspenseSearchConds(searchedTerm))
    else runFetch('all', next)
  }

  const handleConfirmLink = async () => {
    if (!confirmTarget || linking) return
    setLinking(true)
    setError(null)
    const { error: rpcErr } = await supabase.rpc('link_finance_payment_to_order_request', {
      p_payment_request_id: confirmTarget.id,
      p_order_request_id:   request.id,
    })
    setLinking(false)
    if (rpcErr) {
      const { text, stale } = friendlyLinkError(rpcErr.message)
      // Only drop the row when the payment itself is no longer eligible; a
      // request-level or transient failure leaves it in place for a retry.
      if (stale) {
        const staleId = confirmTarget.id
        setResults(prev => prev.filter(p => p.id !== staleId))
      }
      setConfirmTarget(null)
      setError(text)
      return
    }
    const linked = confirmTarget
    setConfirmTarget(null)
    setResults(prev => prev.filter(p => p.id !== linked.id))
    onLinked(linked)
  }

  const labelStyle: React.CSSProperties = {
    fontSize: '11px', fontWeight: 700, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', width: '100%', boxSizing: 'border-box', outline: 'none',
  }

  return (
    <div style={{ padding: '14px 16px', borderRadius: '10px', background: colors.raised, border: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={labelStyle}>
        {ownOnlyUserId ? 'Link a Payment You Submitted' : 'Link Suspense Payment'}
      </div>

      {/* Search row */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <input
          ref={searchInputRef}
          style={{ ...inputStyle, flex: '1 1 260px' }}
          value={query}
          onChange={e => { setQuery(e.target.value); if (inputNotice) setInputNotice(null) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSearch() } }}
          placeholder="Search by UTR, payer, amount or payment date"
          aria-label={ownOnlyUserId ? 'Search your available payments' : 'Search suspense payments'}
        />
        <button
          type="button"
          onClick={handleSearch}
          disabled={!query.trim() || searching}
          style={{
            padding: '8px 16px', borderRadius: '6px', fontSize: '13px', fontWeight: 600,
            background: '#DC1F2E', border: 'none', color: '#fff',
            cursor: (!query.trim() || searching) ? 'not-allowed' : 'pointer',
            opacity: (!query.trim() || searching) ? 0.6 : 1,
          }}
        >
          Search
        </button>
        <button
          type="button"
          onClick={handleViewAll}
          disabled={searching}
          style={{
            padding: '8px 14px', borderRadius: '6px', fontSize: '13px', fontWeight: 600,
            background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
            cursor: searching ? 'not-allowed' : 'pointer',
          }}
        >
          {ownOnlyUserId ? 'View your available payments' : 'View all suspense payments'}
        </button>
      </div>

      {/* Confirmation — compact, inline, no separate popup */}
      {confirmTarget && (
        <div style={{
          padding: '10px 12px', borderRadius: '8px',
          background: '#F5F3FF', border: '1px solid #DDD6FE',
          display: 'flex', flexDirection: 'column', gap: '10px',
        }}>
          <div style={{ fontSize: '13px', color: '#5B21B6', lineHeight: 1.5 }}>
            Link <strong>{fmtAmount(confirmTarget.amount)}</strong> received from{' '}
            <strong>{confirmTarget.client_name}</strong> to <strong>{request.request_number}</strong>?
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setConfirmTarget(null)}
              disabled={linking}
              style={{
                padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
                cursor: linking ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmLink}
              disabled={linking}
              style={{
                padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                background: '#5B21B6', border: 'none', color: '#fff',
                cursor: linking ? 'not-allowed' : 'pointer', opacity: linking ? 0.7 : 1,
              }}
            >
              {linking ? 'Linking…' : 'Confirm & Link'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
          {error}
        </div>
      )}

      {/* Results / states */}
      {searching ? (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '6px 0' }}>Searching suspense payments…</div>
      ) : inputNotice ? (
        <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
          {inputNotice}
        </div>
      ) : mode == null ? (
        <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
          {ownOnlyUserId
            ? 'Search the approved payments you submitted, or view them all. Only payments that are approved and not yet attached elsewhere can be linked.'
            : 'Search for a suspense payment or view all available entries.'}
        </div>
      ) : results.length === 0 ? (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '6px 0' }}>
          {ownOnlyUserId
            ? 'None of your payments are available to link. A payment must be approved by an admin first.'
            : 'No available suspense payments found.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {results.map(p => (
            <div
              key={p.id}
              style={{
                border: `1px solid ${colors.border}`, borderRadius: '8px',
                padding: '10px 12px', background: colors.base,
                display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start',
              }}
            >
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtAmount(p.amount)}
                  </span>
                  <span style={{ fontSize: '12px', color: colors.secondary }}>{fmtDate(p.payment_date)}</span>
                </div>
                <div style={{ fontSize: '12.5px', color: colors.primary, wordBreak: 'break-word' }}>{p.client_name}</div>
                <div style={{ fontSize: '11.5px', color: colors.muted, display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <span>{p.request_number}</span>
                  <span aria-hidden="true">·</span>
                  <span>{PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode}</span>
                  <span aria-hidden="true">·</span>
                  <span>{RECEIVED_IN_LABEL[p.received_in] ?? p.received_in}</span>
                </div>
                {p.proof_note && (
                  <div style={{ fontSize: '11.5px', color: colors.muted, wordBreak: 'break-word' }}>
                    Ref: {p.proof_note}
                  </div>
                )}
                {p.sales_note && (
                  <div style={{ fontSize: '11.5px', color: colors.muted, wordBreak: 'break-word' }}>
                    {p.sales_note}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setError(null); setConfirmTarget(p) }}
                disabled={linking}
                style={{
                  flexShrink: 0, padding: '6px 12px', borderRadius: '6px',
                  fontSize: '12px', fontWeight: 600,
                  background: confirmTarget?.id === p.id ? '#5B21B6' : 'transparent',
                  border: `1px solid ${confirmTarget?.id === p.id ? '#5B21B6' : colors.border}`,
                  color: confirmTarget?.id === p.id ? '#fff' : colors.blue,
                  cursor: linking ? 'not-allowed' : 'pointer',
                }}
              >
                Link payment
              </button>
            </div>
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={handleShowMore}
              style={{
                alignSelf: 'flex-start', background: 'none', border: 'none', padding: '2px 0',
                cursor: 'pointer', font: 'inherit', fontSize: '12px', fontWeight: 600,
                color: colors.blue, textDecoration: 'underline', textUnderlineOffset: '2px',
              }}
            >
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Payments section ──────────────────────────────────────────────────────────
// The payments actually attached to this request, read with the viewer's own
// RLS by order_request_id — the only linkage an open request can have.
// Admins and the requester see the identical list; only the available actions
// differ.

// Read-only detail view for one linked payment. Same two-column shell, proof
// block and activity timeline the Finance Received Payments detail modal uses,
// so a payment reads the same wherever it is opened. Editing never happens
// here — it is Finance's own workflow, reached through the Edit action.
function LinkedPaymentDetailsModal({
  payment: p,
  supabase,
  onClose,
}: {
  payment: LinkedPayment
  supabase: ReturnType<typeof createClient>
  onClose: () => void
}) {
  const meta = paymentStatusMeta(p)
  const left = (
    <>
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' }}>
          <div style={{ minWidth: 0 }}>
            <SectionHeader>Amount</SectionHeader>
            <div style={{ fontSize: '28px', fontWeight: 700, color: colors.primary, lineHeight: 1.1, marginTop: '4px', fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>
              {fmtAmount(p.amount)}
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <SectionHeader>Client</SectionHeader>
            <div style={{ fontSize: '18px', fontWeight: 600, color: colors.primary, lineHeight: 1.3, marginTop: '4px', wordBreak: 'break-word' }}>
              {p.client_name}
            </div>
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: '4px' }}>
          <DetailRow label="Payment Date" value={fmtDate(p.payment_date)} />
          <DetailRow label="Payment Mode" value={PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode} />
          <DetailRow label="Received In"  value={RECEIVED_IN_LABEL[p.received_in]  ?? p.received_in} />
          <DetailRow label="Reference"    value={p.proof_note || '—'} muted={!p.proof_note} />
          <DetailRow
            label={p.order_number ? 'Order Number' : 'Linked Order Request'}
            value={p.order_number ?? p.order_request_number ?? '—'}
            muted={!p.order_number && !p.order_request_number}
          />
          <DetailRow label="Submitted By" value={p.submitted_by_name ?? '—'} muted={!p.submitted_by_name} last />
        </div>
      </div>

      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0 }}>Proof</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PaymentProofView supabase={supabase} paymentRequestId={p.id} renderEmpty inline />
        </div>
      </div>

      {p.sales_note && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <SectionHeader>Notes</SectionHeader>
          <div style={{ fontSize: '13.5px', color: colors.secondary, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {p.sales_note}
          </div>
        </div>
      )}
    </>
  )

  const right = (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px' }}>
      <PaymentRequestActivity supabase={supabase} paymentRequestId={p.id} />
    </div>
  )

  return (
    <RequestModalShell
      requestNumber={p.request_number}
      submittedLine={p.submitted_by_name ? `Submitted by ${p.submitted_by_name} · ${fmtDate(p.created_at)}` : `Submitted ${fmtDate(p.created_at)}`}
      statusBadge={
        <span style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
          background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
          fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
        }}>
          {meta.label}
        </span>
      }
      onClose={onClose}
      left={left}
      right={right}
      ariaLabel={`Payment ${p.request_number}`}
    />
  )
}

// Detach a payment from this request, back to plain suspense. Routed through
// unlink_finance_payment_from_order_request (20260698/20260699), which requires
// a non-empty reason and re-checks authorization server-side.
function UnlinkPaymentModal({
  payment: p,
  request,
  supabase,
  onClose,
  onUnlinked,
}: {
  payment: LinkedPayment
  request: OrderRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onUnlinked: (payment: LinkedPayment) => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const valid = reason.trim().length > 0

  const handleUnlink = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    const { error: rpcErr } = await supabase.rpc('unlink_finance_payment_from_order_request', {
      p_payment_request_id: p.id,
      p_reason:             reason,
    })
    setSaving(false)
    if (rpcErr) {
      const m = (rpcErr.message ?? '').toLowerCase()
      setError(
        m.includes('only an admin') || m.includes('payment you submitted')
          ? 'You do not have permission to unlink this payment.'
          : m.includes('no linked order request')
            ? 'This payment is no longer linked to this request. Refresh and try again.'
            : 'Could not unlink this payment. Please refresh and try again.'
      )
      return
    }
    onUnlinked(p)
  }

  return (
    <FinanceModal title="Unlink Payment?" width="420px" onClose={() => { if (!saving) onClose() }}>
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
        This removes the link between <strong>{p.request_number}</strong> ({fmtAmount(p.amount)} from{' '}
        <strong>{p.client_name}</strong>) and <strong>{request.request_number}</strong>. The payment
        returns to suspense and stops counting towards this request&rsquo;s advance.
      </div>
      <label style={{
        display: 'flex', flexDirection: 'column', gap: '4px',
        fontSize: '11px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        Reason *
        <textarea
          autoFocus
          className="boe-input"
          value={reason}
          onChange={e => { setReason(e.target.value); setError(null) }}
          placeholder="Why is this payment being unlinked? (required)"
          rows={2}
          disabled={saving}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </label>
      {error && (
        <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '8px 18px', fontSize: '13px' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleUnlink}
          disabled={saving || !valid}
          style={{
            padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
            border: `1px solid ${colors.border}`, background: colors.raised, color: colors.primary,
            cursor: (saving || !valid) ? 'not-allowed' : 'pointer',
            opacity: (saving || !valid) ? 0.6 : 1,
          }}
        >
          {saving ? 'Unlinking…' : 'Yes, Unlink'}
        </button>
      </div>
    </FinanceModal>
  )
}

const PAYMENTS_TH: React.CSSProperties = {
  padding: '7px 10px', textAlign: 'left',
  fontSize: '10px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  borderBottom: `1px solid ${colors.border}`, background: colors.raised,
}
const PAYMENTS_TD: React.CSSProperties = {
  padding: '8px 10px', borderBottom: `1px solid ${colors.border}`,
  fontSize: '12px', color: colors.secondary, whiteSpace: 'nowrap',
}

function RequestPaymentsPanel({
  request: r,
  supabase,
  isAdmin,
  currentUserId,
  refreshKey,
  onView,
  onEdit,
  onUnlink,
}: {
  request: OrderRequest
  supabase: ReturnType<typeof createClient>
  isAdmin: boolean
  currentUserId: string
  // Bumped by the parent after a link or unlink so the list re-reads real
  // state rather than being patched optimistically.
  refreshKey: number
  onView:   (p: LinkedPayment) => void
  onEdit:   (p: LinkedPayment) => void
  onUnlink: (p: LinkedPayment) => void
}) {
  const [rows,    setRows]    = useState<LinkedPayment[]>([])
  const [linkedBy, setLinkedBy] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError(null)
      const columns = `
        id, request_number, client_name, amount, payment_date, payment_mode,
        received_in, proof_note, sales_note, status, payment_against,
        order_id, order_number, order_request_id, order_request_number,
        submitted_by, created_at,
        submitted_by_user:users!submitted_by(full_name)
      `
      // Only open requests reach this modal, so the pre-conversion linkage is
      // the only one that can hold: payments are parked on the request itself
      // via order_request_id. Conversion moves them to the Order, where the
      // Order detail page lists them.
      const paymentsQuery = supabase
        .from('finance_payment_requests').select(columns).eq('order_request_id', r.id)

      const [payRes, actRes] = await Promise.all([
        paymentsQuery.order('payment_date', { ascending: false }).order('id', { ascending: false }),
        // "Linked by" comes from the request's own activity trail, the only
        // place the linker is recorded. A payment attached during conversion
        // from the admin's manual selection has no such row and honestly shows
        // "—" rather than borrowing the submitter's name.
        supabase
          .from('order_request_activity')
          .select('details, created_at, actor:users!actor_id(full_name)')
          .eq('order_request_id', r.id)
          .eq('event_type', 'payment_linked')
          .order('created_at', { ascending: true }),
      ])
      if (!active) return

      if (payRes.error) {
        setRows([])
        setError('Could not load the payments for this request.')
        setLoading(false)
        return
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRows(((payRes.data ?? []) as any[]).map(p => ({
        ...p,
        amount: Number(p.amount),
        submitted_by_name: p.submitted_by_user?.full_name ?? undefined,
        submitted_by_user: undefined,
      })) as LinkedPayment[])

      const actors: Record<string, string> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of (actRes.data ?? []) as any[]) {
        const paymentId = row?.details?.payment_id
        const actor = Array.isArray(row?.actor) ? row.actor[0] : row?.actor
        // Ascending order means a later re-link overwrites an earlier one.
        if (typeof paymentId === 'string') actors[paymentId] = actor?.full_name ?? 'System'
      }
      setLinkedBy(actors)
      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [supabase, r.id, refreshKey])

  // A linked payment is always approved, so the creator-edit window
  // (pending/needs_clarification/rejected — finance_payment_requests_own_update)
  // has closed for a requester. The rule is still evaluated per row rather than
  // assumed, so the button appears if and only if the database would allow it.
  const canEditPayment = (p: LinkedPayment) =>
    isAdmin || (p.submitted_by === currentUserId
      && ['pending_approval', 'needs_clarification', 'rejected'].includes(p.status))

  // Only a payment still parked on THIS request can be detached here; once it
  // has transferred to the converted Order, unlinking is Finance's workflow.
  const canUnlinkPayment = (p: LinkedPayment) =>
    canManagePayments(r, currentUserId, isAdmin)
    && p.order_request_id === r.id
    && p.payment_against === 'new_order'
    && (isAdmin || p.submitted_by === currentUserId)

  const total = rows.reduce((sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0), 0)

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden' }}>
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
      }}>
        <SectionHeader>Payments</SectionHeader>
        <span style={{ fontSize: '11.5px', color: colors.muted }}>
          {loading
            ? 'Loading…'
            : rows.length === 0
              ? 'None linked'
              : `${rows.length} payment${rows.length !== 1 ? 's' : ''} · ${fmtAmount(total)}`}
        </span>
      </div>

      {error ? (
        <div style={{ padding: '14px', fontSize: '12px', color: colors.red }}>{error}</div>
      ) : loading ? (
        <div style={{ padding: '14px', fontSize: '12px', color: colors.muted }}>Loading payments…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '14px', fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
          No payments are linked to this request yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '820px' }}>
            <thead>
              <tr>
                <th style={PAYMENTS_TH}>Payment #</th>
                <th style={PAYMENTS_TH}>Date</th>
                <th style={{ ...PAYMENTS_TH, textAlign: 'right' }}>Amount</th>
                <th style={PAYMENTS_TH}>Mode</th>
                <th style={PAYMENTS_TH}>Reference</th>
                <th style={PAYMENTS_TH}>Status</th>
                <th style={PAYMENTS_TH}>Linked By</th>
                <th style={{ ...PAYMENTS_TH, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const meta = paymentStatusMeta(p)
                return (
                  <tr key={p.id}>
                    <td style={{ ...PAYMENTS_TD, fontWeight: 700, color: colors.primary }}>{p.request_number}</td>
                    <td style={PAYMENTS_TD}>{fmtDate(p.payment_date)}</td>
                    <td style={{ ...PAYMENTS_TD, textAlign: 'right', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtAmount(p.amount)}
                    </td>
                    <td style={PAYMENTS_TD}>{PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode}</td>
                    <td style={{ ...PAYMENTS_TD, whiteSpace: 'normal', maxWidth: '180px', wordBreak: 'break-word' }}>
                      {p.proof_note || '—'}
                    </td>
                    <td style={PAYMENTS_TD}>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
                        background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
                        fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
                      }}>
                        {meta.label}
                      </span>
                    </td>
                    <td style={PAYMENTS_TD}>{linkedBy[p.id] ?? '—'}</td>
                    <td style={{ ...PAYMENTS_TD, textAlign: 'right' }}>
                      <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                        <button
                          type="button"
                          onClick={() => onView(p)}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                        >
                          View
                        </button>
                        {canEditPayment(p) && (
                          <button
                            type="button"
                            onClick={() => onEdit(p)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                          >
                            Edit
                          </button>
                        )}
                        {canUnlinkPayment(p) && (
                          <button
                            type="button"
                            onClick={() => onUnlink(p)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.muted }}
                          >
                            Unlink
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RequestDetailsModal({
  request: r,
  advance,
  isAdmin,
  currentUserId,
  supabase,
  autoOpenLinkPanel,
  onClose,
  onConvert,
  onClarify,
  onReject,
  onDeleteRequest,
  onResubmit,
  onReapply,
  onEditRequest,
  onAddPayment,
  onEditPayment,
  onPaymentLinked,
  onPaymentUnlinked,
}: {
  request: OrderRequest
  advance: AdvanceInfo
  isAdmin: boolean
  currentUserId: string
  supabase: ReturnType<typeof createClient>
  autoOpenLinkPanel: boolean
  onClose: () => void
  onConvert: () => void
  onClarify: () => void
  onReject: () => void
  onDeleteRequest: () => void
  onResubmit: () => void
  onReapply: () => void
  onEditRequest: () => void
  onAddPayment: () => void
  onEditPayment: (payment: LinkedPayment) => void
  onPaymentLinked: (payment: SuspensePayment) => void
  onPaymentUnlinked: () => void
}) {
  // Payment linking is offered to an admin or to the request's own requester,
  // and only while the request is still open — exactly the rule
  // link_finance_payment_to_order_request enforces server-side (20260699).
  const canLinkPayment = canManagePayments(r, currentUserId, isAdmin)
  // A non-admin's link search is restricted to their own submissions; an admin
  // keeps the full suspense-ledger search.
  const linkScopeUserId = isAdmin ? null : currentUserId

  // The panel is collapsed by default; it expands only from an explicit Link
  // action (table cell or summary button), never on plain modal open. When it
  // auto-opens (table "Link payment"), focus lands on the search input.
  const [linkPanelOpen, setLinkPanelOpen] = useState(autoOpenLinkPanel && canLinkPayment)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const openLinkPanel = () => {
    setLinkPanelOpen(true)
    setTimeout(() => searchInputRef.current?.focus(), 0)
  }
  useEffect(() => {
    if (autoOpenLinkPanel && canLinkPayment) {
      setTimeout(() => searchInputRef.current?.focus(), 0)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Payments section state. `paymentsKey` forces the panel to re-read after a
  // link or unlink instead of being patched in place.
  const [paymentsKey,   setPaymentsKey]   = useState(0)
  const [viewPayment,   setViewPayment]   = useState<LinkedPayment | null>(null)
  const [unlinkPayment, setUnlinkPayment] = useState<LinkedPayment | null>(null)

  // Header support area: client name clearly visible but secondary to the
  // request number, with the requester/date line muted beneath it.
  const submittedLine = (
    <>
      <span style={{ display: 'block', fontSize: '15.5px', fontWeight: 500, color: colors.primary, wordBreak: 'break-word', lineHeight: 1.3 }}>
        {r.client_name}
      </span>
      <span style={{ display: 'block', marginTop: '3px' }}>
        {r.requested_by_name ? `Requested by ${r.requested_by_name} · ` : ''}Submitted {fmtDate(r.created_at)}
      </span>
    </>
  )

  // Status-specific decision block, tinted with the request's status colours —
  // shown whenever the stored note exists (clarification_note is cleared on
  // resubmit and rejection_reason on reapply, so presence tracks status).
  const decision = r.clarification_note
    ? { title: 'Clarification requested', bg: '#EFF6FF', border: '#BFDBFE', color: '#1E3A8A', note: r.clarification_note }
    : r.rejection_reason
      ? { title: 'Rejection reason', bg: '#FEF2F2', border: '#FECACA', color: '#7F1D1D', note: r.rejection_reason }
      : null

  // Both details panels share this frame: the section label carries the top
  // padding, the rows carry their own vertical rhythm, and no fixed heights —
  // the two columns start level and each ends where its content ends.
  const panelStyle: React.CSSProperties = {
    border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '14px 16px 5px',
  }

  // ── Commercial summary — one full-width panel, four aligned metric groups
  // separated by the 1px divider grid (the border-coloured grid gap), so the
  // figures read as a single surface and the dividers reflow correctly when
  // the groups wrap to 2×2 or a single column on narrow viewports. ──
  const top = (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1px', background: colors.border }}>
        <MetricGroup label="Total Order Value"   value={fmtAmount(r.total_value)}         valueMuted={r.total_value == null} />
        <MetricGroup label="Total Product Value" value={fmtAmount(r.total_product_value)} valueMuted={r.total_product_value == null} />
        {advance.kind === 'request_linked' ? (
          <>
            <MetricGroup
              label="Advance Received"
              value={formatINR(advance.received)}
              note={`${advance.count} payment${advance.count !== 1 ? 's' : ''} linked`}
              action={canLinkPayment ? <SummaryLinkButton label="Link another" onClick={openLinkPanel} /> : undefined}
            />
            <MetricGroup label="Payment Position" value="—" valueMuted note="Available after conversion" />
          </>
        ) : advance.kind === 'not_linked' ? (
          <>
            <MetricGroup
              label="Advance Received"
              value="Not linked"
              valueMuted
              note={canLinkPayment ? undefined : 'Payments link after conversion'}
              action={canLinkPayment ? <SummaryLinkButton label="Link payment" onClick={openLinkPanel} /> : undefined}
            />
            <MetricGroup label="Payment Position" value="—" valueMuted note="Available after conversion" />
          </>
        ) : (
          <>
            <MetricGroup label="Advance Received" value="—" valueMuted note="Could not be loaded" />
            <MetricGroup label="Payment Position" value="—" valueMuted />
          </>
        )}
      </div>
    </div>
  )

  // ── Main details — two level columns of compact rows ──
  const left = (
    <div style={panelStyle}>
      <SectionHeader>Request Details</SectionHeader>
      <div style={{ marginTop: '3px' }}>
        <DetailRow label="Client" value={r.client_name} />
        <DetailRow
          label="Lead Source"
          value={LEAD_SOURCE_OPTIONS.find(o => o.value === r.lead_source)?.label ?? '—'}
          muted={!r.lead_source}
        />
        <DetailRow label="Confirmation Date" value={fmtDate(r.confirm_date)} muted={!r.confirm_date} />
        <DetailRow label="Due Date"          value={fmtDate(r.due_date)}     muted={!r.due_date} last />
      </div>
    </div>
  )

  const right = (
    <div style={panelStyle}>
      <SectionHeader>Ownership &amp; Timeline</SectionHeader>
      <div style={{ marginTop: '3px' }}>
        <DetailRow label="Requested By" value={r.requested_by_name ?? '—'} muted={!r.requested_by_name} />
        <DetailRow label="Assignee"     value={r.assigned_to_name  ?? '—'} muted={!r.assigned_to_name} />
        <DetailRow label="Submitted On" value={fmtDate(r.created_at)} last />
      </div>
    </div>
  )

  // ── Context and decision history — full-width blocks, only when data exists ──
  const contextLabelStyle = (color: string): React.CSSProperties => ({
    fontSize: '11px', fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '5px',
  })
  const contextBodyStyle = (color: string): React.CSSProperties => ({
    fontSize: '13.5px', color, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  })
  const bottom = (
    <>
      {r.notes?.trim() && (
        <div style={{ padding: '12px 16px', borderRadius: '10px', background: colors.raised, border: `1px solid ${colors.border}` }}>
          <div style={contextLabelStyle(colors.muted)}>Notes</div>
          <div style={contextBodyStyle(colors.secondary)}>{r.notes}</div>
        </div>
      )}

      {decision && (
        <div style={{ padding: '12px 16px', borderRadius: '10px', background: decision.bg, border: `1px solid ${decision.border}` }}>
          <div style={contextLabelStyle(decision.color)}>{decision.title}</div>
          <div style={contextBodyStyle(decision.color)}>{decision.note}</div>
        </div>
      )}

      {/* Payments attached to this request. Identical for admin and requester;
          only the per-row actions differ. */}
      <RequestPaymentsPanel
        request={r}
        supabase={supabase}
        isAdmin={isAdmin}
        currentUserId={currentUserId}
        refreshKey={paymentsKey}
        onView={setViewPayment}
        onEdit={onEditPayment}
        onUnlink={setUnlinkPayment}
      />

      {/* Order-first payment linking — expands only from an explicit Link
          action, below Notes and any decision block. */}
      {canLinkPayment && linkPanelOpen && (
        <RequestPaymentLinkPanel
          request={r}
          supabase={supabase}
          searchInputRef={searchInputRef}
          ownOnlyUserId={linkScopeUserId}
          onLinked={payment => { setPaymentsKey(k => k + 1); onPaymentLinked(payment) }}
        />
      )}
    </>
  )

  // ── Actions ──
  // Admin review actions are unchanged. The requester-side actions are the
  // same set in all three open statuses (edit the request, add a payment, link
  // a payment); only the terminal hand-back button differs — Resubmit after a
  // clarification, Reapply after a rejection, neither on a plain submitted
  // request. Every one of them mirrors a server-side gate: the two form RPCs,
  // the requester UPDATE policy, and the link RPC respectively.
  const canReview    = isAdmin && r.status === 'submitted'
  const isRequester  = isPermittedRequester(r, currentUserId)
  const canResubmit  = r.status === 'needs_clarification' && isRequester
  const canReapply   = r.status === 'rejected' && isRequester
  // Editing a plain submitted request is a direct, policy-checked update
  // (order_requests_requester_update); the other two statuses are edited
  // through their own RPC as part of Resubmit / Reapply, so a separate Edit
  // button there would be a second door to the same change.
  const canEditRequestNow = canEditRequest(r, currentUserId, isAdmin) && r.status === 'submitted'
  const canAddPayment     = canManagePayments(r, currentUserId, isAdmin)

  // Deleting an Order Request is admin-only and only while it is UNCONVERTED —
  // the same rule order_requests_admin_delete_unconverted and the
  // order_requests_prevent_converted_delete trigger enforce server-side
  // (20260705000000). A converted request produced a Confirmed Order and is
  // permanent source history, so it never offers this.
  const canDeleteRequest = isAdmin && r.status !== 'converted' && !r.converted_order_id

  const hasFooter = canReview || canResubmit || canReapply
    || canEditRequestNow || canAddPayment || canLinkPayment || canDeleteRequest

  const actionBtn: React.CSSProperties = {
    padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  }
  const secondaryBtn: React.CSSProperties = {
    ...actionBtn, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
  }
  const footer = hasFooter ? (
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
      {/* Destructive action stays visually separated on the far left */}
      {canReview && (
        <button onClick={onReject} style={{ ...actionBtn, background: 'transparent', border: '1px solid #FECACA', color: '#991B1B' }}>
          Reject Request
        </button>
      )}
      {canDeleteRequest && (
        <button onClick={onDeleteRequest} style={{ ...actionBtn, background: 'transparent', border: '1px solid #FECACA', color: '#991B1B' }}>
          Delete Request
        </button>
      )}
      <div style={{ flex: 1 }} />
      {canEditRequestNow && (
        <button onClick={onEditRequest} style={secondaryBtn}>
          Edit Request
        </button>
      )}
      {canAddPayment && (
        <button onClick={onAddPayment} style={secondaryBtn}>
          Add Payment
        </button>
      )}
      {canLinkPayment && (
        <button onClick={openLinkPanel} style={secondaryBtn}>
          Link Payment
        </button>
      )}
      {canReview && (
        <button onClick={onClarify} style={secondaryBtn}>
          Request Clarification
        </button>
      )}
      {canReview && (
        <button onClick={onConvert} style={{ ...actionBtn, background: '#DC1F2E', border: 'none', color: '#fff' }}>
          Convert
        </button>
      )}
      {canResubmit && (
        <button onClick={onResubmit} style={{ ...actionBtn, background: '#1E40AF', border: 'none', color: '#fff' }}>
          Update and Resubmit
        </button>
      )}
      {canReapply && (
        <button onClick={onReapply} style={{ ...actionBtn, background: '#1E40AF', border: 'none', color: '#fff' }}>
          Update and Reapply
        </button>
      )}
    </div>
  ) : undefined

  return (
    <>
      <RequestModalShell
        requestNumber={r.request_number}
        submittedLine={submittedLine}
        statusBadge={<StatusBadge status={r.status} />}
        // A payment dialog layered above must not tear down the request view
        // underneath it — same guard the page applies for its own action modals.
        onClose={() => { if (!viewPayment && !unlinkPayment) onClose() }}
        top={top}
        left={left}
        right={right}
        bottom={bottom}
        footer={footer}
        width="980px"
        ariaLabel={`Order request ${r.request_number}`}
      />

      {viewPayment && (
        <LinkedPaymentDetailsModal
          key={viewPayment.id}
          payment={viewPayment}
          supabase={supabase}
          onClose={() => setViewPayment(null)}
        />
      )}

      {unlinkPayment && (
        <UnlinkPaymentModal
          payment={unlinkPayment}
          request={r}
          supabase={supabase}
          onClose={() => setUnlinkPayment(null)}
          onUnlinked={() => {
            setUnlinkPayment(null)
            setPaymentsKey(k => k + 1)
            onPaymentUnlinked()
          }}
        />
      )}
    </>
  )
}

// ── Submit Order Request modal ────────────────────────────────────────────────

type RequestForm = {
  client_name: string
  assigned_to: string
  confirm_date: string
  due_date: string
  total_product_value: string
  total_value: string
  lead_source: string
  notes: string
}

const EMPTY_FORM: RequestForm = {
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
function validateAmount(label: string, raw: string): string | null {
  if (raw === '') return null
  const n = parseFloat(raw)
  if (Number.isNaN(n) || n < 0) return `${label} must be a valid non-negative amount.`
  return null
}

function SubmitRequestModal({
  salesAssignees,
  overrideAssignees,
  currentUserId,
  onClose,
  onSubmitted,
}: {
  salesAssignees: AssigneeOption[]
  overrideAssignees: AssigneeOption[]
  currentUserId: string
  onClose: () => void
  onSubmitted: (requestNumber: string) => void
}) {
  // Default to the current user only when they're actually eligible — never
  // the first eligible user in the list.
  const [form,   setForm]   = useState<RequestForm>(() => {
    const isSelfEligible = salesAssignees.some(u => u.id === currentUserId)
      || overrideAssignees.some(u => u.id === currentUserId)
    return { ...EMPTY_FORM, assigned_to: isSelfEligible ? currentUserId : '' }
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const set = (k: keyof RequestForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.client_name.trim()) { setError('Client name is required.'); return }
    const productValueError = validateAmount('Total Product Value', form.total_product_value)
    if (productValueError) { setError(productValueError); return }
    const orderValueError = validateAmount('Total Order Value', form.total_value)
    if (orderValueError) { setError(orderValueError); return }
    setSaving(true)
    setError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setError('Not authenticated.'); setSaving(false); return }

    // No order number, no display_number: this only creates an order_requests
    // row. request_number (ORD-REQ-YYYY-NNNN) is assigned by the database.
    // requested_by is not a form field: the authenticated user submitting the
    // request is saved automatically, mirroring created_by.
    const payload = {
      client_name:          form.client_name.trim(),
      requested_by:         session.user.id,
      assigned_to:          form.assigned_to || null,
      confirm_date:         form.confirm_date || null,
      due_date:             form.due_date     || null,
      total_product_value:  form.total_product_value ? parseFloat(form.total_product_value) : null,
      total_value:          form.total_value  ? parseFloat(form.total_value) : null,
      lead_source:          form.lead_source  || null,
      notes:                form.notes.trim() || null,
      created_by:           session.user.id,
    }

    const { data: created, error: insertErr } = await supabase
      .from('order_requests')
      .insert(payload)
      .select('id, request_number')
      .single()

    if (insertErr || !created) {
      setError(insertErr?.message?.includes('Assignee must be')
        ? insertErr.message
        : (insertErr?.message ?? 'Failed to submit order request.'))
      setSaving(false)
      return
    }

    // Notify reviewers, and the assigned user when one is set (non-blocking).
    void notifyOrders({
      event: 'order_submitted',
      requestNumber: created.request_number,
      entityId: created.id,
      clientName: form.client_name.trim(),
      creatorId: session.user.id,
      assignedTo: form.assigned_to || null,
    })

    onSubmitted(created.request_number)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', width: '100%', boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '540px',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Submit Order Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              A request number is assigned on submission. No order is created yet.
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Client Name *
              <input style={inputStyle} value={form.client_name} onChange={set('client_name')} placeholder="Client name" required />
            </label>
            <label style={labelStyle}>
              Assignee
              <select style={inputStyle} value={form.assigned_to} onChange={set('assigned_to')}>
                <option value="">— Select —</option>
                {salesAssignees.length > 0 && (
                  <optgroup label="Sales Team">
                    {salesAssignees.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                  </optgroup>
                )}
                {overrideAssignees.length > 0 && (
                  <optgroup label="Authorised Assignees">
                    {overrideAssignees.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Confirmation Date
              <input type="date" style={inputStyle} value={form.confirm_date} onChange={set('confirm_date')} />
            </label>
            <label style={labelStyle}>
              Due Date
              <input type="date" style={inputStyle} value={form.due_date} onChange={set('due_date')} />
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Total Product Value (₹)
              <input type="number" min="0" step="0.01" style={inputStyle} value={form.total_product_value} onChange={set('total_product_value')} placeholder="0" />
            </label>
            <label style={labelStyle}>
              Total Order Value (₹)
              <input type="number" min="0" step="0.01" style={inputStyle} value={form.total_value} onChange={set('total_value')} placeholder="0" />
            </label>
          </div>

          <label style={labelStyle}>
            Lead Source
            <select style={inputStyle} value={form.lead_source} onChange={set('lead_source')}>
              <option value="">— Select —</option>
              {LEAD_SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>

          <label style={labelStyle}>
            Notes
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical', fontFamily: 'inherit' }}
              value={form.notes}
              onChange={set('notes')}
              placeholder="Any additional notes…"
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary, cursor: 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}>
              {saving ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Convert to Order modal (admin only) ───────────────────────────────────────
// Confirmation only: every value that ends up on the official Order is derived
// server-side by convert_order_request_to_order(). There is deliberately no
// Order-number input and no editing of request fields here.

function ConvertModal({
  request,
  onClose,
  onConverted,
}: {
  request: OrderRequest
  onClose: () => void
  onConverted: (result: ConvertResult) => void
}) {
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [payments, setPayments] = useState<EligiblePayment[]>([])
  const [preLinked, setPreLinked] = useState<EligiblePayment[]>([])
  const [loadingPayments, setLoadingPayments] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const supabase = useMemo(() => createClient(), [])

  // Eligible = approved but not yet attached to any Order OR any Order
  // Request. Payments already parked on THIS request (order_request_id,
  // 20260698) are loaded separately: the conversion RPC transfers them
  // automatically, so they are shown as fixed, not selectable. Payments
  // parked on a DIFFERENT request are excluded entirely. Admin-only data:
  // this relies on the existing finance_payment_requests admin SELECT policy,
  // so no Finance visibility is widened for anyone else. The DB order
  // (payment_date desc) is the newest-first tie-break preserved within each
  // client-match group by the stable sort in `sortedPayments` below — the
  // match/mismatch grouping itself has no column to sort by server-side,
  // since it depends on comparing against this specific request's client_name.
  const loadEligiblePayments = async () => {
    setLoadingPayments(true)
    const paymentColumns = 'id, request_number, client_name, amount, payment_date, proof_note, submitted_by_user:users!submitted_by(full_name)'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapRows = (rows: any[]): EligiblePayment[] => rows.map(p => ({
      id: p.id,
      request_number: p.request_number,
      client_name: p.client_name,
      amount: p.amount,
      payment_date: p.payment_date,
      proof_note: p.proof_note ?? null,
      submitted_by_name: p.submitted_by_user?.full_name ?? undefined,
    }))

    const [eligibleRes, preLinkedRes] = await Promise.all([
      supabase
        .from('finance_payment_requests')
        .select(paymentColumns)
        .eq('status', 'approved_unlinked')
        .is('order_id', null)
        .is('order_request_id', null)
        .order('payment_date', { ascending: false }),
      supabase
        .from('finance_payment_requests')
        .select(paymentColumns)
        .eq('order_request_id', request.id)
        .order('payment_date', { ascending: false }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped = mapRows((eligibleRes.data ?? []) as any[])
    setPayments(mapped)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPreLinked(mapRows((preLinkedRes.data ?? []) as any[]))
    setLoadingPayments(false)
    return mapped
  }

  // Refresh eligibility whenever the modal opens.
  useEffect(() => {
    const onMount = () => { loadEligiblePayments() }
    onMount()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Matching-client-first, newest-first within each group. Array.prototype.sort
  // is a stable sort (guaranteed by spec since ES2019), so a comparator that
  // only looks at the match/mismatch boolean preserves the payment_date-desc
  // order the query already returned within each group — no secondary sort
  // key needed here.
  const requestClientNorm = useMemo(() => normalizeClientName(request.client_name), [request.client_name])
  const isClientMatch = (p: EligiblePayment) => normalizeClientName(p.client_name) === requestClientNorm
  const sortedPayments = useMemo(
    () => payments.slice().sort((a, b) => Number(isClientMatch(b)) - Number(isClientMatch(a))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payments, requestClientNorm]
  )

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedList  = payments.filter(p => selected.has(p.id))
  const selectedTotal = selectedList.reduce((sum, p) => sum + Number(p.amount), 0)
  // Display/warning only — never blocks selection or conversion. Recomputed
  // from the live selection, so it appears and disappears exactly with
  // deselection, no separate state to keep in sync.
  const mismatchedSelected = selectedList.filter(p => !isClientMatch(p))

  const handleConvert = async () => {
    if (saving) return  // guards against double-clicks; the RPC is the real guard
    setSaving(true)
    setError(null)

    const { data, error: rpcErr } = await supabase.rpc('convert_order_request_to_order', {
      p_order_request_id:    request.id,
      p_payment_request_ids: Array.from(selected),
    })

    if (rpcErr || !data) {
      // A payment we offered was linked by someone else in the meantime: re-read
      // eligibility, drop what is gone from the selection, and keep the modal
      // open. Nothing was created — the RPC rolled the whole conversion back.
      if (rpcErr?.message?.includes('STALE_PAYMENTS')) {
        const fresh = await loadEligiblePayments()
        const stillEligible = new Set(fresh.map(p => p.id))
        setSelected(prev => new Set(Array.from(prev).filter(id => stillEligible.has(id))))
        setError('One or more selected payments are no longer available. The list has been refreshed.')
      } else {
        // Order numbering failures (20260703000000) get their own plain-language
        // sentence. They are not "try again" problems — nothing about retrying
        // fixes an unconfigured or stale Order number cycle, and the generic
        // message below would send the admin round a loop that cannot succeed.
        // Like STALE_PAYMENTS, the whole conversion rolled back, so no Order was
        // created, no payment moved, and the configured number did not advance.
        const numbering = orderNumberErrorMessage(rpcErr?.message, 'conversion')
        setError(numbering ?? 'Could not convert this request. Please refresh and try again.')
      }
      setSaving(false)
      return
    }

    const result = data as ConvertResult

    // Notify the creator and the assigned user of the conversion. Any payments
    // linked during conversion are covered by this single notification.
    //
    // entityId is the ORDER id, not the request id — unlike every other Order
    // notification. The subject of this event is the Confirmed Order that now
    // exists, and getNotificationMeta routes order_converted to /orders/{id}
    // accordingly. Pointing it at the request would deep-link into the Order
    // Requests module, which no longer surfaces converted requests.
    void notifyOrders({
      event: 'order_converted',
      requestNumber: request.request_number,
      entityId: result.order_id,
      clientName: request.client_name,
      creatorId: request.requested_by,
      assignedTo: request.assigned_to,
      orderNumber: result.order_display_number,
    })

    onConverted(result)
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between', gap: '16px',
    padding: '7px 0', borderBottom: `1px solid ${colors.border}`, fontSize: '13px',
  }
  const keyStyle: React.CSSProperties = {
    color: colors.muted, fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  }
  const valStyle: React.CSSProperties = { color: colors.primary, textAlign: 'right' }

  const carried: { label: string; value: string }[] = [
    { label: 'Client',                 value: request.client_name },
    { label: 'Requested By',           value: request.requested_by_name ?? '—' },
    { label: 'Assignee',               value: request.assigned_to_name ?? '—' },
    { label: 'Confirmation Date',      value: fmtDate(request.confirm_date) },
    { label: 'Due Date',               value: fmtDate(request.due_date) },
    { label: 'Total Product Value',    value: fmtAmount(request.total_product_value) },
    { label: 'Total Order Value',      value: fmtAmount(request.total_value) },
    { label: 'Lead Source',            value: LEAD_SOURCE_OPTIONS.find(o => o.value === request.lead_source)?.label ?? '—' },
    { label: 'Notes',                  value: request.notes?.trim() || '—' },
  ]

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '520px',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Convert to Official Order</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{
            fontSize: '12px', color: '#92400E',
            background: '#FFFBEB', border: '1px solid #FDE68A',
            borderRadius: '6px', padding: '9px 12px', lineHeight: 1.5,
          }}>
            An official Order number will be allocated automatically when you confirm.
            This cannot be undone — the request will be permanently marked Converted
            and linked to the new Order.
          </div>

          <div>
            <div style={{ ...keyStyle, marginBottom: '4px' }}>Carried into the official Order</div>
            {carried.map(f => (
              <div key={f.label} style={rowStyle}>
                <span style={keyStyle}>{f.label}</span>
                <span style={valStyle}>{f.value}</span>
              </div>
            ))}
          </div>

          {/* ── Payments already linked to this request — transfer automatically ── */}
          {!loadingPayments && preLinked.length > 0 && (
            <div>
              <div style={{ ...keyStyle, marginBottom: '6px' }}>Linked Payments — Transfer Automatically</div>
              <div style={{ border: '1px solid #DDD6FE', background: '#F5F3FF', borderRadius: '6px' }}>
                {preLinked.map((p, idx) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex', justifyContent: 'space-between', gap: '10px',
                      padding: '8px 10px',
                      borderBottom: idx < preLinked.length - 1 ? '1px solid #DDD6FE' : 'none',
                    }}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#5B21B6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.request_number}
                      <span style={{ fontWeight: 500, color: colors.secondary }}> · {p.client_name} · {fmtDate(p.payment_date)}</span>
                    </span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {fmtAmount(p.amount)}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '11px', color: colors.muted, marginTop: '4px', lineHeight: 1.5 }}>
                {preLinked.length === 1 ? 'This payment is' : 'These payments are'} linked to this
                request and will move to the new official Order automatically.
              </div>
            </div>
          )}

          {/* ── Optional: link approved payments ── */}
          <div>
            <div style={{ ...keyStyle, marginBottom: '6px' }}>
              Approved Payments Available to Link{' '}
              <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>(optional)</span>
            </div>

            {loadingPayments ? (
              <div style={{ fontSize: '12px', color: colors.muted, padding: '10px 0' }}>Loading payments…</div>
            ) : payments.length === 0 ? (
              <div style={{
                fontSize: '12px', color: colors.muted,
                border: `1px dashed ${colors.border}`, borderRadius: '6px',
                padding: '12px', textAlign: 'center',
              }}>
                No approved payments are waiting to be linked.
              </div>
            ) : (
              <>
                <div style={{
                  border: `1px solid ${colors.border}`, borderRadius: '6px',
                  maxHeight: '220px', overflowY: 'auto',
                }}>
                  {sortedPayments.map((p, idx) => {
                    const on = selected.has(p.id)
                    const matches = isClientMatch(p)
                    // A subtle divider where the matching group ends and the
                    // non-matching group begins — display only, never hides
                    // mismatched payments.
                    const prevMatches = idx > 0 ? isClientMatch(sortedPayments[idx - 1]) : matches
                    const showDivider = idx > 0 && prevMatches && !matches
                    return (
                      <div key={p.id}>
                        {showDivider && (
                          <div style={{
                            padding: '4px 10px', fontSize: '10px', fontWeight: 700,
                            color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em',
                            background: colors.raised, borderBottom: `1px solid ${colors.border}`,
                          }}>
                            Other clients
                          </div>
                        )}
                        <label
                          style={{
                            display: 'flex', alignItems: 'center', gap: '10px',
                            padding: '8px 10px', cursor: 'pointer',
                            borderBottom: `1px solid ${colors.border}`,
                            background: on ? 'rgba(220,31,46,0.04)' : 'transparent',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(p.id)}
                            disabled={saving}
                            style={{ cursor: 'pointer', flexShrink: 0 }}
                          />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                              <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p.request_number}
                                <span style={{ fontWeight: 500, color: colors.secondary }}> · {p.client_name}</span>
                                {!matches && (
                                  <span style={{
                                    marginLeft: '6px', fontSize: '10px', fontWeight: 600,
                                    color: '#9A3412', background: '#FFF7ED', border: '1px solid #FED7AA',
                                    borderRadius: '4px', padding: '1px 5px',
                                  }}>
                                    Different client
                                  </span>
                                )}
                              </span>
                              <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap', flexShrink: 0 }}>
                                {fmtAmount(p.amount)}
                              </span>
                            </span>
                            <span style={{
                              display: 'block', fontSize: '11px', color: colors.muted,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {fmtDate(p.payment_date)}
                              {p.submitted_by_name ? ` · ${p.submitted_by_name}` : ''}
                              {p.proof_note ? ` · ${p.proof_note}` : ''}
                            </span>
                          </span>
                        </label>
                      </div>
                    )
                  })}
                </div>

                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: '12px', paddingTop: '8px',
                  color: selected.size > 0 ? colors.primary : colors.muted,
                }}>
                  <span>{selected.size} payment{selected.size !== 1 ? 's' : ''} selected</span>
                  <span style={{ fontWeight: selected.size > 0 ? 700 : 400 }}>{fmtAmount(selectedTotal)}</span>
                </div>

                {selected.size > 0 && (
                  <div style={{ fontSize: '11px', color: colors.muted, marginTop: '4px', lineHeight: 1.5 }}>
                    The selected payment{selected.size !== 1 ? 's' : ''} will be linked to the new official
                    Order and marked as received.
                  </div>
                )}

                {mismatchedSelected.length > 0 && (
                  <div style={{
                    fontSize: '11px', color: '#9A3412', background: '#FFF7ED',
                    border: '1px solid #FED7AA', borderRadius: '6px',
                    padding: '8px 10px', marginTop: '8px', lineHeight: 1.5,
                  }}>
                    <div>
                      The recorded client on this payment does not match the client on this order request.
                      Confirm that this is the correct payment before creating the order.
                    </div>
                    <ul style={{ margin: '6px 0 0', paddingLeft: '16px' }}>
                      {mismatchedSelected.map(p => (
                        <li key={p.id}>
                          {p.request_number} — payment client &ldquo;{p.client_name}&rdquo;, order request client &ldquo;{request.client_name}&rdquo;
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button type="button" onClick={handleConvert} disabled={saving} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}>
              {saving ? 'Converting…' : 'Confirm & Convert'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Request Clarification modal (admin only) ──────────────────────────────────
// Deliberately separate from ConvertModal: asking a question and creating an
// official Order are different decisions and must not share a confirmation.

function ClarifyModal({
  request,
  onClose,
  onRequested,
}: {
  request: OrderRequest
  onClose: () => void
  onRequested: (requestNumber: string) => void
}) {
  const [note,   setNote]   = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const noteValid = note.trim().length > 0

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving || !noteValid) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('request_order_request_clarification', {
      p_order_request_id:   request.id,
      p_clarification_note: note,
    })

    if (rpcErr) {
      // Modal stays open so the admin can retry or copy their note out.
      setError('Could not request clarification. The request may have already changed. Please refresh and try again.')
      setSaving(false)
      return
    }

    // Tell the creator their request needs clarification.
    void notifyOrders({
      event: 'order_clarification',
      requestNumber: request.request_number,
      entityId: request.id,
      clientName: request.client_name,
      creatorId: request.requested_by,
    })

    onRequested(request.request_number)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '460px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Request Clarification</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
            The request goes back to the requester, who can update it and resubmit
            it for review. It cannot be converted until then.
          </div>

          <label style={labelStyle}>
            What needs clarifying? *
            <textarea
              autoFocus
              style={{
                padding: '7px 10px', borderRadius: '6px',
                border: `1px solid ${colors.border}`,
                background: colors.raised, color: colors.primary,
                fontSize: '13px', width: '100%', boxSizing: 'border-box',
                outline: 'none', minHeight: '80px', resize: 'vertical',
                fontFamily: 'inherit',
              }}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Ask the requester what to correct or add…"
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !noteValid} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: (saving || !noteValid) ? 'not-allowed' : 'pointer',
              opacity: (saving || !noteValid) ? 0.5 : 1,
            }}>
              {saving ? 'Sending…' : 'Request Clarification'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Delete Request modal (admin only, unconverted only) ───────────────────────
//
// Deleting an Order Request is legitimate cleanup of something that was never
// finalized — a duplicate, a mistake, a request that will never proceed. It is
// NOT how a converted request goes away: that one produced a Confirmed Order and
// is permanent source history, which the database enforces independently of this
// modal (20260705000000).
//
// The one case that needs care is a request with approved payments parked on it.
// Those are real money sitting in Suspense, so they are DETACHED and kept, never
// deleted, and the modal says so before the admin commits. Detaching and
// deleting happen in one transaction inside admin_delete_order_request() — doing
// them as two client calls would leave a window where the payments are unparked
// but the request survives.

// admin_delete_order_request raises stable, greppable code prefixes. Each one is
// a rule the reader can act on, so each gets a sentence rather than a shared
// "something went wrong" that hides which rule refused. An unrecognised message
// falls through unchanged — still more useful than a generic string.
function deleteRequestErrorMessage(message: string): string {
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

function DeleteRequestModal({
  request,
  onClose,
  onDeleted,
}: {
  request: OrderRequest
  onClose: () => void
  onDeleted: (requestNumber: string, unlinkedCount: number) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [payments, setPayments] = useState<{ id: string; request_number: string; amount: number }[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('finance_payment_requests')
        .select('id, request_number, amount')
        .eq('order_request_id', request.id)
      setPayments((data ?? []) as { id: string; request_number: string; amount: number }[])
    }
    void load()
  }, [supabase, request.id])

  const linkedCount  = payments?.length ?? 0
  const linkedAmount = (payments ?? []).reduce((sum, p) => sum + Number(p.amount ?? 0), 0)

  const handleDelete = async () => {
    if (deleting) return
    setDeleting(true)
    setError(null)

    const { data, error: rpcErr } = await supabase.rpc('admin_delete_order_request', {
      p_order_request_id: request.id,
      // Only ever true when the admin has been shown the payments and the button
      // they clicked says so.
      p_unlink_payments:  linkedCount > 0,
    })

    if (rpcErr) {
      // Modal stays open, and the database's own message is shown rather than a
      // generic failure — it names the actual rule that refused.
      setDeleting(false)
      setError(deleteRequestErrorMessage(rpcErr.message))
      return
    }

    const res = data as { unlinked_count?: number } | null
    onDeleted(request.request_number, res?.unlinked_count ?? 0)
  }

  const keyStyle: React.CSSProperties = {
    color: colors.muted, fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget && !deleting) onClose() }}
    >
      <div style={{
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '12px', width: '100%', maxWidth: '480px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Delete Order Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={deleting}
            style={{ background: 'none', border: 'none', cursor: deleting ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Request Number</span>
              <span style={{ color: colors.primary, fontWeight: 600 }}>{request.request_number}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Status</span>
              <StatusBadge status={request.status} />
            </div>
            {linkedCount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={keyStyle}>Linked Payments</span>
                <span style={{ color: colors.primary }}>
                  {linkedCount} · {formatINR(linkedAmount)}
                </span>
              </div>
            )}
          </div>

          <div style={{
            fontSize: '12px', color: '#991B1B',
            background: '#FEF2F2', border: '1px solid #FECACA',
            borderRadius: '6px', padding: '9px 12px', lineHeight: 1.55,
          }}>
            <strong>Will be deleted:</strong> this Order Request and its activity history.
            {linkedCount === 0 && ' Nothing else is affected.'}
          </div>

          {linkedCount > 0 && (
            <div style={{
              fontSize: '12px', color: '#166534',
              background: '#F0FDF4', border: '1px solid #BBF7D0',
              borderRadius: '6px', padding: '9px 12px', lineHeight: 1.55,
            }}>
              <strong>Will be kept:</strong> {linkedCount} received{' '}
              {linkedCount === 1 ? 'payment' : 'payments'} totalling {formatINR(linkedAmount)}.
              {' '}They are real bank payments and are never deleted — they will be unlinked from
              this request and returned to Suspense, ready to attach elsewhere.
            </div>
          )}

          {error && (
            <div style={{
              padding: '9px 12px', borderRadius: '6px',
              background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px', lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button
              onClick={onClose}
              disabled={deleting}
              style={{
                padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
                background: 'transparent', border: `1px solid ${colors.border}`,
                color: colors.secondary, cursor: deleting ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting || payments === null}
              style={{
                padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
                background: colors.red, border: 'none', color: '#fff',
                cursor: deleting || payments === null ? 'not-allowed' : 'pointer',
                opacity: deleting || payments === null ? 0.7 : 1,
              }}
            >
              {deleting
                ? 'Deleting…'
                : linkedCount > 0 ? 'Unlink Payments and Delete' : 'Delete Request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Reject Request modal (admin only) ──────────────────────────────────────────
// Deliberately separate from ConvertModal and ClarifyModal: rejecting is a
// terminal decision distinct from asking a question or creating an Order, and
// must not share a confirmation with either.

function RejectModal({
  request,
  onClose,
  onRejected,
}: {
  request: OrderRequest
  onClose: () => void
  onRejected: (requestNumber: string) => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const reasonValid = reason.trim().length > 0

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving || !reasonValid) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('reject_order_request', {
      p_order_request_id: request.id,
      p_rejection_reason: reason,
    })

    if (rpcErr) {
      // Modal stays open so the admin can retry or copy their reason out.
      setError('Could not reject this request. It may have already changed. Please refresh and try again.')
      setSaving(false)
      return
    }

    // Tell the creator their request was rejected.
    void notifyOrders({
      event: 'order_rejected',
      requestNumber: request.request_number,
      entityId: request.id,
      clientName: request.client_name,
      creatorId: request.requested_by,
    })

    onRejected(request.request_number)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const keyStyle: React.CSSProperties = {
    color: colors.muted, fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '460px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Reject Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{
            fontSize: '12px', color: '#991B1B',
            background: '#FEF2F2', border: '1px solid #FECACA',
            borderRadius: '6px', padding: '9px 12px', lineHeight: 1.5,
          }}>
            This cannot be undone. The request will be permanently marked Rejected
            and cannot be converted or resubmitted.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Request Number</span>
              <span style={{ color: colors.primary, fontWeight: 600 }}>{request.request_number}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Client</span>
              <span style={{ color: colors.primary }}>{request.client_name}</span>
            </div>
          </div>

          <label style={labelStyle}>
            Rejection Reason *
            <textarea
              autoFocus
              style={{
                padding: '7px 10px', borderRadius: '6px',
                border: `1px solid ${colors.border}`,
                background: colors.raised, color: colors.primary,
                fontSize: '13px', width: '100%', boxSizing: 'border-box',
                outline: 'none', minHeight: '80px', resize: 'vertical',
                fontFamily: 'inherit',
              }}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Explain why this request is being rejected…"
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !reasonValid} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#991B1B', border: 'none', color: '#fff',
              cursor: (saving || !reasonValid) ? 'not-allowed' : 'pointer',
              opacity: (saving || !reasonValid) ? 0.5 : 1,
            }}>
              {saving ? 'Rejecting…' : 'Reject Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Edit / Resubmit / Reapply modal (permitted requester only) ────────────────
// One form, three outcomes. The fields, validation, assignee grouping and
// legacy-assignee handling were identical across the three flows, so they share
// a single implementation; only the framing block, the submit target and the
// button wording differ:
//
//   edit     — a request still sitting at 'submitted'. A direct UPDATE, allowed
//              by order_requests_requester_update; the status is untouched, so
//              this is a correction, not a resubmission.
//   resubmit — a request sent back for clarification. resubmit_order_request
//              applies the edits and returns it to 'submitted' in one statement.
//   reapply  — a rejected request. reapply_order_request, same shape.
//
// Each path is gated server-side by the same rule the button uses: the two RPCs
// re-check requester ownership and the exact source status, the direct update is
// checked by RLS, and order_requests_guard_converted (20260699) refuses all
// three once the request has been converted.

type RequestFormMode = 'edit' | 'resubmit' | 'reapply'

const REQUEST_FORM_META: Record<RequestFormMode, { title: string; submit: string; saving: string }> = {
  edit:     { title: 'Edit Order Request',  submit: 'Save Changes',        saving: 'Saving…' },
  resubmit: { title: 'Update and Resubmit', submit: 'Update and Resubmit', saving: 'Resubmitting…' },
  reapply:  { title: 'Update and Reapply',  submit: 'Update and Reapply',  saving: 'Reapplying…' },
}

function RequestFormModal({
  mode,
  request,
  salesAssignees,
  overrideAssignees,
  onClose,
  onSaved,
}: {
  mode: RequestFormMode
  request: OrderRequest
  salesAssignees: AssigneeOption[]
  overrideAssignees: AssigneeOption[]
  onClose: () => void
  onSaved: (requestNumber: string) => void
}) {
  // A legacy assignee that no longer qualifies (inactive, or neither Sales
  // nor authorised) stays visible and selected — never silently dropped.
  const isLegacyAssigneeOutOfList = !!request.assigned_to
    && !salesAssignees.some(u => u.id === request.assigned_to)
    && !overrideAssignees.some(u => u.id === request.assigned_to)

  const [form, setForm] = useState<RequestForm>({
    client_name:         request.client_name,
    assigned_to:         request.assigned_to ?? '',
    confirm_date:        request.confirm_date ?? '',
    due_date:            request.due_date ?? '',
    total_product_value: request.total_product_value != null ? String(request.total_product_value) : '',
    total_value:         request.total_value != null ? String(request.total_value) : '',
    lead_source:         request.lead_source ?? '',
    notes:               request.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])
  const meta = REQUEST_FORM_META[mode]

  const set = (k: keyof RequestForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  // The one thing that genuinely differs between the three modes. Returns an
  // error message, or null on success.
  const persist = async (): Promise<string | null> => {
    if (mode === 'edit') {
      // No status change: a plain correction to a request still under review.
      // The assignee-eligibility trigger (20260697) validates assigned_to on
      // this path exactly as it does inside the RPCs.
      const { data, error: dbErr } = await supabase
        .from('order_requests')
        .update({
          client_name:         form.client_name.trim(),
          assigned_to:         form.assigned_to  || null,
          confirm_date:        form.confirm_date || null,
          due_date:            form.due_date     || null,
          total_value:         form.total_value  ? parseFloat(form.total_value) : null,
          total_product_value: form.total_product_value ? parseFloat(form.total_product_value) : null,
          lead_source:         form.lead_source  || null,
          notes:               form.notes.trim() || null,
          updated_at:          new Date().toISOString(),
        })
        .eq('id', request.id)
        .select('id')
        .maybeSingle()

      if (dbErr) {
        return dbErr.message?.includes('Assignee must be')
          ? dbErr.message
          : dbErr.message?.includes('can no longer be edited')
            ? 'This request has been converted and can no longer be edited.'
            : 'Could not save this request. It may have already changed. Please refresh and try again.'
      }
      // RLS filtered the row out: the request left the editable state (or was
      // never this user's) between opening the form and saving.
      if (!data) return 'This request can no longer be edited. Please refresh and try again.'
      return null
    }

    const { error: rpcErr } = await supabase.rpc(
      mode === 'resubmit' ? 'resubmit_order_request' : 'reapply_order_request',
      {
        p_order_request_id:    request.id,
        p_client_name:         form.client_name,
        p_assigned_to:         form.assigned_to  || null,
        p_confirm_date:        form.confirm_date || null,
        p_due_date:            form.due_date     || null,
        p_total_value:         form.total_value  ? parseFloat(form.total_value) : null,
        p_total_product_value: form.total_product_value ? parseFloat(form.total_product_value) : null,
        p_lead_source:         form.lead_source  || null,
        p_notes:               form.notes,
      },
    )
    if (!rpcErr) return null
    if (rpcErr.message?.includes('Assignee must be')) return rpcErr.message
    return mode === 'resubmit'
      ? 'Could not resubmit this request. It may have already changed. Please refresh and try again.'
      : 'Could not reapply this request. It may have already changed. Please refresh and try again.'
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    if (!form.client_name.trim()) { setError('Client name is required.'); return }
    const productValueError = validateAmount('Total Product Value', form.total_product_value)
    if (productValueError) { setError(productValueError); return }
    const orderValueError = validateAmount('Total Order Value', form.total_value)
    if (orderValueError) { setError(orderValueError); return }
    setSaving(true)
    setError(null)

    const failure = await persist()
    if (failure) { setError(failure); setSaving(false); return }

    // Only a hand-back to the reviewers' queue is announced. An in-place edit
    // of an already-submitted request changes no state anyone is waiting on,
    // so it raises no notification.
    if (mode !== 'edit') {
      void notifyOrders({
        event: 'order_resubmitted',
        requestNumber: request.request_number,
        entityId: request.id,
        clientName: form.client_name.trim(),
      })
    }

    onSaved(request.request_number)
  }

  // The context being addressed — the clarification question or the rejection
  // reason — stays visible for the whole edit, above the fields.
  const context = mode === 'resubmit' && request.clarification_note
    ? { label: 'Clarification requested', bg: '#EFF6FF', border: '#BFDBFE', labelColor: '#1E40AF', textColor: '#1E3A8A', body: request.clarification_note }
    : mode === 'reapply' && request.rejection_reason
      ? { label: 'Rejection reason', bg: '#FEF2F2', border: '#FECACA', labelColor: '#991B1B', textColor: '#7F1D1D', body: request.rejection_reason }
      : null

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', width: '100%', boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '540px',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>{meta.title}</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {context && (
            <div style={{
              background: context.bg, border: `1px solid ${context.border}`,
              borderRadius: '6px', padding: '10px 12px',
            }}>
              <div style={{
                fontSize: '10px', fontWeight: 700, color: context.labelColor,
                textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
              }}>
                {context.label}
              </div>
              <div style={{ fontSize: '13px', color: context.textColor, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {context.body}
              </div>
            </div>
          )}

          {mode === 'edit' && (
            <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
              This request stays under review — saving updates its details without
              resubmitting it.
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Client Name *
              <input style={inputStyle} value={form.client_name} onChange={set('client_name')} required />
            </label>
            <label style={labelStyle}>
              Assignee
              <select style={inputStyle} value={form.assigned_to} onChange={set('assigned_to')}>
                <option value="">— Select —</option>
                {isLegacyAssigneeOutOfList && (
                  <optgroup label="Current Assignee">
                    <option value={request.assigned_to ?? ''}>{request.assigned_to_name ?? 'Unknown user'}</option>
                  </optgroup>
                )}
                {salesAssignees.length > 0 && (
                  <optgroup label="Sales Team">
                    {salesAssignees.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                  </optgroup>
                )}
                {overrideAssignees.length > 0 && (
                  <optgroup label="Authorised Assignees">
                    {overrideAssignees.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Confirmation Date
              <input type="date" style={inputStyle} value={form.confirm_date} onChange={set('confirm_date')} />
            </label>
            <label style={labelStyle}>
              Due Date
              <input type="date" style={inputStyle} value={form.due_date} onChange={set('due_date')} />
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Total Product Value (₹)
              <input type="number" min="0" step="0.01" style={inputStyle} value={form.total_product_value} onChange={set('total_product_value')} />
            </label>
            <label style={labelStyle}>
              Total Order Value (₹)
              <input type="number" min="0" step="0.01" style={inputStyle} value={form.total_value} onChange={set('total_value')} />
            </label>
          </div>

          <label style={labelStyle}>
            Lead Source
            <select style={inputStyle} value={form.lead_source} onChange={set('lead_source')}>
              <option value="">— Select —</option>
              {LEAD_SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>

          <label style={labelStyle}>
            Notes
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical', fontFamily: 'inherit' }}
              value={form.notes}
              onChange={set('notes')}
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}>
              {saving ? meta.saving : meta.submit}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OrderRequestsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <OrderRequestsPageInner />
    </Suspense>
  )
}

function OrderRequestsPageInner() {
  const [pageLoading,   setPageLoading]   = useState(true)
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string>('')
  const [requests,      setRequests]      = useState<OrderRequest[]>([])
  const [assigneeOptions, setAssigneeOptions] = useState<AssigneeOption[]>([])
  const [listLoading,   setListLoading]   = useState(false)
  const [search,        setSearch]        = useState('')
  const [showModal,     setShowModal]     = useState(false)
  const [successNumber, setSuccessNumber] = useState<string | null>(null)
  const [convertTarget, setConvertTarget] = useState<OrderRequest | null>(null)
  const [converted,     setConverted]     = useState<ConvertResult | null>(null)
  const [clarifyTarget,  setClarifyTarget]  = useState<OrderRequest | null>(null)
  const [resubmitTarget, setResubmitTarget] = useState<OrderRequest | null>(null)
  const [rejectTarget,   setRejectTarget]   = useState<OrderRequest | null>(null)
  const [deleteTarget,   setDeleteTarget]   = useState<OrderRequest | null>(null)
  const [reapplyTarget,  setReapplyTarget]  = useState<OrderRequest | null>(null)
  const [editTarget,     setEditTarget]     = useState<OrderRequest | null>(null)
  const [detailsTarget,  setDetailsTarget]  = useState<OrderRequest | null>(null)
  const [actionMessage,  setActionMessage]  = useState<string | null>(null)
  const [highlightId,    setHighlightId]    = useState<string | null>(null)
  // Pre-conversion parking: total + count of suspense payments parked on each
  // request via order_request_id (20260698). null means the aggregate could not
  // be read at all — rendered as "—", never as a false ₹0.
  const [linkedByRequest, setLinkedByRequest] = useState<Record<string, RequestLinkAgg> | null>(null)
  // When true, the details modal that opens should auto-expand its payment-link
  // panel (set by the table's Link action, cleared on any other open).
  const [autoExpandPanel, setAutoExpandPanel] = useState(false)

  const router       = useRouter()
  const searchParams = useSearchParams()

  // ?tab= from the Admin Action Queue selects the initial tab; manual tab
  // clicks below still just call setStatusTab and are otherwise untouched.
  const [statusTab, setStatusTab] = useState<StatusFilter>(() => parseStatusFilter(searchParams.get('tab')))

  // Guards the one-time ?request= deep-link resolution below so it can never
  // re-fire and reopen a modal the admin already closed.
  const deepLinkHandled = useRef(false)
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()

  const loadRequests = async () => {
    setListLoading(true)
    // Converted requests are excluded HERE, not by a tab filter: this module
    // lists only requests that still need action, and conversion is the exit
    // from it. The row is never deleted — it stays in public.order_requests
    // permanently (and 20260701's orders.source_order_request_id FK makes that
    // a database guarantee), reachable through the Confirmed Order it produced.
    // Excluding by status is exact rather than approximate:
    // order_requests_converted_consistency (20260680) makes status='converted'
    // and converted_order_id IS NOT NULL equivalent, so this filter drops every
    // converted row and no other.
    const { data } = await supabase
      .from('order_requests')
      .select(`
        id, request_number, client_name,
        requested_by, assigned_to,
        confirm_date, due_date, total_value, total_product_value, lead_source, notes,
        status, created_by, clarification_note, rejection_reason, created_at, converted_order_id,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name)
      `)
      .neq('status', 'converted')
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: OrderRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      requested_by_name:            r.requested_by_user?.full_name ?? undefined,
      assigned_to_name:             r.assigned_to_user?.full_name  ?? undefined,
      requested_by_user: undefined,
      assigned_to_user:  undefined,
    }))
    setRequests(mapped)
    // Keeps OrdersLayout's "Order Requests" nav badge (a separate query, so it
    // stays live on every /orders/* page, not just this one) in sync with
    // every reload here — creation, convert, reject, clarify, resubmit, reapply.
    // The badge counts the same scope as the "All" tab, so any reload that can
    // change which requests appear must invalidate it.
    queryClient.invalidateQueries({ queryKey: ['order-requests', 'total-count'] })

    // Advance-received aggregation — one batched query, no per-row N+1: the
    // suspense payments parked on the listed requests (order_request_id,
    // 20260698) for the pre-conversion total + count. The post-conversion
    // figure is not needed here, because no converted request is listed.
    //
    // Run for every viewer, not just admins. The query is keyed to the ids of
    // requests already on screen, and a non-admin only ever sees requests they
    // own — for which finance_payment_requests_order_request_owner_select
    // (20260699) exposes every attached payment. So the sums are complete for
    // both roles, and the requester finally sees the same advance figure the
    // admin does instead of a "Finance access required" placeholder. A failed
    // query leaves the map null, which renders as "—" rather than a false ₹0.
    const requestIds = mapped.map(r => r.id)

    const parkedRes = requestIds.length > 0
      ? await supabase
          .from('finance_payment_requests')
          .select('order_request_id, amount')
          .eq('status', 'approved_unlinked')
          .in('order_request_id', requestIds)
      : { data: [], error: null }

    if (parkedRes.error) {
      setLinkedByRequest(null)
    } else {
      const parked: Record<string, RequestLinkAgg> = {}
      for (const p of (parkedRes.data ?? []) as { order_request_id: string | null; amount: number | string }[]) {
        const amt = Number(p.amount)
        if (p.order_request_id && Number.isFinite(amt)) {
          const agg = parked[p.order_request_id] ?? { total: 0, count: 0 }
          agg.total += amt
          agg.count += 1
          parked[p.order_request_id] = agg
        }
      }
      setLinkedByRequest(parked)
    }

    setListLoading(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setCurrentUserId(session.user.id)

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
        .eq('id', session.user.id)
        .single()
      setProfile(me as UserProfile)

      // Sales team + explicitly authorised Order Assignees only — never every
      // active user. resolve_permission-backed, so overrides never need to be
      // read directly by a non-admin client (employee_permission_overrides
      // RLS only allows a user to read their own row).
      const { data: assigneesData } = await supabase.rpc('list_eligible_order_assignees')
      setAssigneeOptions((assigneesData ?? []) as AssigneeOption[])

      // The advance aggregates are RLS-scoped, not role-scoped, so this no
      // longer needs the freshly-read role handed in.
      await loadRequests()
      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Deep-link resolution (Admin Action Queue → ?tab=&request=&action=convert) ─
  // Runs exactly once, once `requests` is loaded. Auto-opens the existing
  // Convert modal only when the loaded request is still in the same
  // convertible state the manual "Convert" button already requires (admin,
  // status still 'submitted') — a stale or already-converted request just
  // gets highlighted, never a fatal error.
  useEffect(() => {
    const resolveDeepLink = () => {
      if (pageLoading || deepLinkHandled.current) return
      deepLinkHandled.current = true

      const requestId = searchParams.get('request')
      const action    = searchParams.get('action')
      const rawTab    = searchParams.get('tab')
      if (requestId) {
        const match = requests.find(r => r.id === requestId)
        if (match) {
          setHighlightId(match.id)
          setTimeout(() => setHighlightId(null), 3000)
          document.getElementById(`order-request-row-${match.id}`)?.scrollIntoView({ block: 'center' })
          if (profile?.role === 'admin' && action === 'convert' && match.status === 'submitted') {
            setConvertTarget(match)
          }
        }
        // Drop the record/action params so a refresh or back-navigation
        // can't reopen the modal; keep the tab so the deep link still lands
        // correctly — in its canonical spelling, since statusTab is already
        // the normalized key.
        router.replace(`/orders/requests?tab=${statusTab}`)
      } else if (rawTab != null && rawTab !== statusTab) {
        // A tab-only link carrying a retired key (?tab=active) or an
        // unrecognized one. The page already resolved it to statusTab; rewrite
        // the address bar to match so the old spelling does not survive in
        // history, bookmarks, or anything copied out of the URL bar.
        router.replace(`/orders/requests?tab=${statusTab}`)
      }
    }
    resolveDeepLink()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLoading])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // Grouped for the Assignee dropdowns' optgroups; sorted defensively even
  // though list_eligible_order_assignees() already orders by (source, name).
  const salesAssignees = useMemo(
    () => assigneeOptions.filter(u => u.source === 'sales').sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [assigneeOptions]
  )
  const overrideAssignees = useMemo(
    () => assigneeOptions.filter(u => u.source === 'override').sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [assigneeOptions]
  )

  const visible = useMemo(() => {
    const tab = STATUS_TABS.find(t => t.key === statusTab) ?? STATUS_TABS[0]
    const list = requests.filter(r => tab.match(r.status))
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(r =>
      r.request_number.toLowerCase().includes(q) ||
      r.client_name.toLowerCase().includes(q)
    )
  }, [requests, statusTab, search])

  // Per-tab record counts — computed from the already-loaded `requests` list
  // (no extra query), using each tab's own `match` so a count can never drift
  // from what selecting that tab actually shows. Deliberately ignores the
  // search box: these are total records in the category, not the current
  // filtered view, so switching tabs or typing a search term never changes them.
  const tabCounts = useMemo(() => {
    const counts = {} as Record<StatusFilter, number>
    for (const tab of STATUS_TABS) {
      counts[tab.key] = requests.filter(r => tab.match(r.status)).length
    }
    return counts
  }, [requests])

  const isAdmin = profile?.role === 'admin'

  // Opening a request. Only the table's Link action asks for the payment panel
  // to auto-expand; every ordinary open (row click, keyboard, request-number
  // link) resets it, so a plain open never expands the panel.
  const openDetails = (r: OrderRequest, expandPanel = false) => {
    setAutoExpandPanel(expandPanel)
    setDetailsTarget(r)
  }

  // Table-side Link action: open the correct request with its panel expanded.
  const openLinkForRequest = (r: OrderRequest) => openDetails(r, true)

  if (pageLoading) return <LoadingScreen />

  return (
    <OrdersLayout
      profile={profile}
      title="Order Requests"
      subtitle="Submit and track order requests before they become official orders."
      onSignOut={handleSignOut}
      onRefresh={loadRequests}
    >
      {successNumber && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#166534',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={15} />
            Request submitted — <strong>{successNumber}</strong>. No order has been created yet.
          </span>
          <button
            onClick={() => setSuccessNumber(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
          >
            ✕
          </button>
        </div>
      )}

      {actionMessage && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#166534',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={15} />
            {actionMessage}
          </span>
          <button
            onClick={() => setActionMessage(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
          >
            ✕
          </button>
        </div>
      )}

      {converted && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '12px', flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#166534',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={15} />
            {converted.request_number} converted — official Order{' '}
            <strong>{converted.order_display_number}</strong> created
            {converted.linked_payment_count > 0
              ? `, ${converted.linked_payment_count} payment${converted.linked_payment_count !== 1 ? 's' : ''} linked.`
              : '.'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => router.push(`/orders/${converted.order_id}`)}
              style={{
                padding: '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                background: '#166534', border: 'none', color: '#fff', cursor: 'pointer',
              }}
            >
              Open Order
            </button>
            <button
              onClick={() => setConverted(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
            >
              ✕
            </button>
          </span>
        </div>
      )}

      {/* ── Search + submit toolbar ── form controls only; the status
          navigation lives on the table card below so the two never read as the
          same kind of control. Creating a request belongs here, on the module
          that owns Order Requests. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        marginBottom: '10px',
      }}>
        <input
          className="boe-input"
          placeholder="Search by request number or client…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: '180px', maxWidth: '320px', padding: '6px 10px', fontSize: '12px' }}
        />
        <button
          onClick={() => setShowModal(true)}
          style={{
            padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
            background: '#DC1F2E', border: 'none', color: '#fff', cursor: 'pointer',
            whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          + New Order Request
        </button>
      </div>

      {/* ── Table, with the status strip as its own header ── */}
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        <StatusTabs
          tabs={STATUS_TABS.map(t => ({ key: t.key, label: t.label, Icon: t.Icon, accent: t.accent, count: tabCounts[t.key] }))}
          active={statusTab}
          onSelect={setStatusTab}
          summary={
            listLoading
              ? 'Loading…'
              : search.trim()
                ? `${visible.length} of ${tabCounts[statusTab]} visible`
                : `${visible.length} request${visible.length !== 1 ? 's' : ''}`
          }
        />

        {listLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            No order requests found.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Request #', 'Client', 'Assignee', 'Confirmation Date', 'Due Date', 'Value', 'Advance Received', 'Status'].map(h => (
                    <th key={h} style={{
                      padding: '8px 16px', textAlign: 'left',
                      fontSize: '10px', fontWeight: 600, color: colors.muted,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr
                    key={r.id}
                    id={`order-request-row-${r.id}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open order request ${r.request_number}`}
                    onClick={() => openDetails(r)}
                    onKeyDown={e => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetails(r) }
                    }}
                    style={{
                      cursor: 'pointer',
                      borderBottom: `1px solid ${colors.border}`,
                      background: r.id === highlightId ? colors.amberTint : undefined,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                    onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = r.id === highlightId ? colors.amberTint : 'transparent' }}
                  >
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={e => { e.stopPropagation(); openDetails(r) }}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          font: 'inherit', fontWeight: 600, color: colors.primary,
                          textDecoration: 'underline', textUnderlineOffset: '3px',
                          textDecorationColor: colors.borderMed,
                        }}
                      >
                        {r.request_number}
                      </button>
                      {r.status === 'needs_clarification' && r.clarification_note && (
                        <div
                          title={r.clarification_note}
                          style={{
                            fontSize: '11px', fontWeight: 500, color: '#1E40AF', marginTop: '2px',
                            maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          ? {r.clarification_note}
                        </div>
                      )}
                      {r.status === 'rejected' && r.rejection_reason && (
                        <div
                          title={r.rejection_reason}
                          style={{
                            fontSize: '11px', fontWeight: 500, color: '#991B1B', marginTop: '2px',
                            maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          ✕ {r.rejection_reason}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.primary, maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.client_name}>
                      {r.client_name}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.assigned_to_name ?? undefined}>
                      {r.assigned_to_name ?? '—'}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {fmtDate(r.confirm_date)}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {fmtDate(r.due_date)}
                    </td>
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      <div style={{ fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                        {fmtAmount(r.total_value)}
                      </div>
                      <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
                        Products: {fmtAmount(r.total_product_value)}
                      </div>
                    </td>
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      <AdvanceCell
                        info={getAdvanceInfo(r, linkedByRequest)}
                        canLink={canManagePayments(r, currentUserId, isAdmin)}
                        onLink={() => openLinkForRequest(r)}
                      />
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detailsTarget && (
        <RequestDetailsModal
          // Keyed by request id so panel/search state never leaks from one
          // request to another — a fresh instance mounts per opened request.
          key={detailsTarget.id}
          request={detailsTarget}
          advance={getAdvanceInfo(detailsTarget, linkedByRequest)}
          isAdmin={isAdmin}
          currentUserId={currentUserId}
          supabase={supabase}
          autoOpenLinkPanel={autoExpandPanel}
          // While an action modal is layered above, the shell's Escape/overlay
          // close must not tear down the details view underneath it.
          onClose={() => {
            if (convertTarget || clarifyTarget || rejectTarget || deleteTarget || resubmitTarget || reapplyTarget || editTarget) return
            setDetailsTarget(null)
            setAutoExpandPanel(false)
          }}
          onConvert={()  => setConvertTarget(detailsTarget)}
          onClarify={()  => setClarifyTarget(detailsTarget)}
          onReject={()   => setRejectTarget(detailsTarget)}
          onDeleteRequest={() => setDeleteTarget(detailsTarget)}
          onResubmit={() => setResubmitTarget(detailsTarget)}
          onReapply={()  => setReapplyTarget(detailsTarget)}
          onEditRequest={() => setEditTarget(detailsTarget)}
          // Recording a payment is Finance's own workflow — the same form
          // salespeople already use, opened prefilled for this request rather
          // than reimplemented here. It arrives as a pending request; an admin
          // approves it, and it then becomes available to Link above.
          onAddPayment={() => {
            const params = new URLSearchParams({
              new:    '1',
              client: detailsTarget.client_name,
              note:   `Advance for order request ${detailsTarget.request_number}`,
            })
            router.push(`/finance?${params.toString()}`)
          }}
          // Editing an approved payment is Finance's workflow too, and is
          // admin-only in the database — deep-link to the row there rather than
          // keeping a second edit form in sync with it.
          onEditPayment={payment => {
            router.push(payment.order_id || payment.order_request_id
              ? `/finance/received?payment=${payment.id}&action=edit`
              : `/finance?request=${payment.id}`)
          }}
          onPaymentLinked={payment => {
            setActionMessage(`${fmtAmount(payment.amount)} from ${payment.client_name} linked to ${detailsTarget.request_number}.`)
            loadRequests()
          }}
          onPaymentUnlinked={() => {
            setActionMessage(`Payment unlinked from ${detailsTarget.request_number}. It has returned to suspense.`)
            loadRequests()
          }}
        />
      )}

      {showModal && (
        <SubmitRequestModal
          salesAssignees={salesAssignees}
          overrideAssignees={overrideAssignees}
          currentUserId={currentUserId}
          onClose={() => setShowModal(false)}
          onSubmitted={requestNumber => {
            setShowModal(false)
            setSuccessNumber(requestNumber)
            loadRequests()
          }}
        />
      )}

      {convertTarget && (
        <ConvertModal
          request={convertTarget}
          onClose={() => setConvertTarget(null)}
          onConverted={result => {
            setConvertTarget(null)
            setDetailsTarget(null)
            setSuccessNumber(null)
            setActionMessage(null)
            setConverted(result)
            loadRequests()
          }}
        />
      )}

      {clarifyTarget && (
        <ClarifyModal
          request={clarifyTarget}
          onClose={() => setClarifyTarget(null)}
          onRequested={requestNumber => {
            setClarifyTarget(null)
            setDetailsTarget(null)
            setSuccessNumber(null)
            setConverted(null)
            setActionMessage(`Clarification requested on ${requestNumber}. It now sits under Needs Clarification.`)
            loadRequests()
          }}
        />
      )}

      {editTarget && (
        <RequestFormModal
          mode="edit"
          request={editTarget}
          salesAssignees={salesAssignees}
          overrideAssignees={overrideAssignees}
          onClose={() => setEditTarget(null)}
          onSaved={requestNumber => {
            setEditTarget(null)
            setDetailsTarget(null)
            setSuccessNumber(null)
            setConverted(null)
            setActionMessage(`${requestNumber} updated. It is still under review.`)
            loadRequests()
          }}
        />
      )}

      {resubmitTarget && (
        <RequestFormModal
          mode="resubmit"
          request={resubmitTarget}
          salesAssignees={salesAssignees}
          overrideAssignees={overrideAssignees}
          onClose={() => setResubmitTarget(null)}
          onSaved={requestNumber => {
            setResubmitTarget(null)
            setDetailsTarget(null)
            setSuccessNumber(null)
            setConverted(null)
            setActionMessage(`${requestNumber} updated and resubmitted. It is back under Active for review.`)
            loadRequests()
          }}
        />
      )}

      {rejectTarget && (
        <RejectModal
          request={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onRejected={requestNumber => {
            setRejectTarget(null)
            setDetailsTarget(null)
            setSuccessNumber(null)
            setConverted(null)
            setActionMessage(`${requestNumber} has been rejected.`)
            loadRequests()
          }}
        />
      )}

      {deleteTarget && (
        <DeleteRequestModal
          request={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(requestNumber, unlinkedCount) => {
            setDeleteTarget(null)
            setDetailsTarget(null)
            setSuccessNumber(null)
            setConverted(null)
            setActionMessage(
              unlinkedCount > 0
                ? `${requestNumber} has been deleted. ${unlinkedCount} payment${unlinkedCount === 1 ? '' : 's'} returned to Suspense.`
                : `${requestNumber} has been deleted.`
            )
            loadRequests()
          }}
        />
      )}

      {reapplyTarget && (
        <RequestFormModal
          mode="reapply"
          request={reapplyTarget}
          salesAssignees={salesAssignees}
          overrideAssignees={overrideAssignees}
          onClose={() => setReapplyTarget(null)}
          onSaved={requestNumber => {
            setReapplyTarget(null)
            setDetailsTarget(null)
            setSuccessNumber(null)
            setConverted(null)
            setActionMessage(`${requestNumber} updated and reapplied. It is back under Active for review.`)
            loadRequests()
          }}
        />
      )}
    </OrdersLayout>
  )
}
