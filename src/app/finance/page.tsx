'use client'

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import type { UserProfile } from '@/lib/types'
import { compressImageFile } from '@/lib/attachment-utils'
import { PROOF_BUCKET, validateProofFile, buildProofPath, proofContentType } from '@/lib/paymentProof'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import { formatINR, groupIndianDigits, sanitizeAmountInput, isValidAmount } from '@/lib/currency'
import { notifyFinance } from '@/lib/notify'
import {
  FinanceModal,
  RequestModalShell,
  useModalScrollLockAndEscape,
  FINANCE_MODAL_OVERLAY_Z,
  FINANCE_MODAL_DIALOG_Z,
} from '@/app/finance/components/FinanceModalShell'

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentRequest = {
  id: string
  request_number: string
  client_name: string
  amount: number
  payment_date: string
  payment_mode: string
  received_in: string
  proof_note: string | null
  order_number: string | null
  order_id: string | null
  sales_note: string | null
  payment_against: string
  status: string
  submitted_by: string
  submitted_by_name?: string
  admin_note: string | null
  created_at: string
  updated_at: string
  rejected_at: string | null
  clarification_requested_at: string | null
}

type OrderResult = {
  id: string
  display_number: string
  client_name: string
  total_value: number | null
  status: string
}

type AdminAction = 'approve' | 'needs_clarification' | 'reject'
type FilterTab   = 'pending' | 'order_pending' | 'clarification' | 'rejected' | 'archive' | 'all'

// ── Constants ─────────────────────────────────────────────────────────────────

const PAYMENT_MODE_LABEL: Record<string, string> = {
  // legacy DB payment_mode values (for existing records in the table)
  bank_transfer: 'Bank Transfer',
  cash:          'Cash',
  upi:           'UPI',
  cheque:        'Cheque',
  other:         'Other',
  // UI-key values (received_in-based keys used as combined payment destination).
  // Labels are the account/destination names shown in the UI; the underlying
  // stored values are unchanged so existing records keep displaying correctly.
  company_account: 'HDFC',
  savings_account: 'Canara',
  cash_in_hand:    'Paytm',
  hawala:          'PNB',
}

const RECEIVED_IN_LABEL: Record<string, string> = {
  company_account: 'HDFC',
  cash_in_hand:    'Paytm',
  savings_account: 'Canara',
  other:           'PNB',
}

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_approval:    { label: 'Pending',             bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  approved_unlinked:   { label: 'Order No. Pending',   bg: '#FFF7ED', color: '#92400E', border: '#FED7AA' },
  approved_linked:     { label: 'Received Payment',    bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  needs_clarification: { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  rejected:            { label: 'Rejected',            bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

const ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  running:            { label: 'Running',             color: '#1E40AF' },
  on_hold:            { label: 'On Hold',             color: '#9A3412' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  color: '#5B21B6' },
  dispatched:         { label: 'Dispatched',          color: '#166534' },
  cancelled:          { label: 'Cancelled',           color: '#991B1B' },
}

const PAYMENT_AGAINST_LABEL: Record<string, string> = {
  existing_order: 'Existing Order',
  new_order:      'New Order',
}

const PAYMENT_AGAINST_OPTIONS: { label: string; value: string }[] = [
  { label: 'New Order',      value: 'new_order' },
  { label: 'Existing Order', value: 'existing_order' },
]

// Option values are received_in-style DB keys (DB-safe for that column).
// payment_mode is derived via PAYMENT_MODE_DB_MAP below.
const PAYMENT_MODE_OPTIONS: { label: string; value: string }[] = [
  { label: 'HDFC',   value: 'company_account' },
  { label: 'PNB',    value: 'hawala' },
  { label: 'Paytm',  value: 'cash_in_hand' },
  { label: 'Canara', value: 'savings_account' },
]

// Maps UI option value → DB-safe (payment_mode, received_in) pair.
// DB constraints: payment_mode IN (bank_transfer|cash|upi|cheque|other)
//                 received_in  IN (company_account|cash_in_hand|savings_account|other)
const PAYMENT_MODE_DB_MAP: Record<string, { payment_mode: string; received_in: string }> = {
  company_account: { payment_mode: 'bank_transfer', received_in: 'company_account' },
  savings_account: { payment_mode: 'bank_transfer', received_in: 'savings_account' },
  cash_in_hand:    { payment_mode: 'cash',          received_in: 'cash_in_hand'    },
  hawala:          { payment_mode: 'other',         received_in: 'other'           },
}

// Reverse-maps existing DB column values back to a PAYMENT_MODE_OPTIONS value (for edit form init).
function dbToUiPaymentMode(payment_mode: string, received_in: string): string {
  for (const [key, v] of Object.entries(PAYMENT_MODE_DB_MAP)) {
    if (v.payment_mode === payment_mode && v.received_in === received_in) return key
  }
  return PAYMENT_MODE_OPTIONS[0].value // fallback for legacy-only values
}

// Resolves the correct display label for a stored record's payment_mode + received_in.
// Falls back to the legacy payment_mode label if the pair doesn't match a known UI key.
function displayPaymentMode(payment_mode: string, received_in: string): string {
  const uiKey = dbToUiPaymentMode(payment_mode, received_in)
  const mapped = PAYMENT_MODE_DB_MAP[uiKey]
  if (mapped && mapped.payment_mode === payment_mode && mapped.received_in === received_in) {
    return PAYMENT_MODE_LABEL[uiKey] ?? uiKey
  }
  return PAYMENT_MODE_LABEL[payment_mode] ?? payment_mode
}

const RECEIVED_IN_OPTIONS: { label: string; value: string }[] = [
  { label: 'Company Account', value: 'company_account' },
  { label: 'Cash in Hand',    value: 'cash_in_hand' },
  { label: 'Savings Account', value: 'savings_account' },
  { label: 'Other',           value: 'other' },
]

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'pending',       label: 'Pending' },
  { key: 'order_pending', label: 'Order No. Pending' },
  { key: 'clarification', label: 'Needs Clarification' },
  { key: 'rejected',      label: 'Rejected' },
  { key: 'archive',       label: 'Archive' },
  { key: 'all',           label: 'All' },
]

const EMPTY_MESSAGES: Record<FilterTab, string> = {
  pending:       'No pending payment requests.',
  order_pending: 'No payments with order number pending.',
  clarification: 'No payments awaiting clarification.',
  rejected:      'No rejected payments.',
  archive:       'No archived rejected requests.',
  all:           'No payment requests here.',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Maps an incoming ?tab= value (e.g. from the Admin Action Queue) to a known
// FilterTab, defaulting to 'pending' for anything missing or unrecognized —
// never throws on an invalid/stale deep link.
const FILTER_TAB_KEYS: FilterTab[] = ['pending', 'order_pending', 'clarification', 'rejected', 'archive', 'all']
function parseFilterTab(value: string | null): FilterTab {
  return (FILTER_TAB_KEYS as string[]).includes(value ?? '') ? (value as FilterTab) : 'pending'
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtAmount(n: number) {
  return formatINR(n)
}

// Order No. display for both employee and admin views: shows the real number
// once one exists, otherwise a concise state describing why not. A new_order
// request never allocates a number through approval (20260690000000) — it
// only reaches one when it is later attached to a real Order (Order Request
// conversion, or the Finance linking RPC), so approved_unlinked and
// pending/in-review new_order requests need distinct copy.
function orderNoDisplay(r: PaymentRequest): string {
  if (r.order_number) return r.order_number
  if (r.payment_against === 'new_order') {
    return r.status === 'approved_unlinked'
      ? 'Received — awaiting order creation'
      : 'New Order — no order created yet'
  }
  return '—'
}

// Maps the approved_linked-requires-order_id CHECK constraint violation to a
// clear message instead of surfacing the raw Postgres error.
function friendlyDbErrorMessage(dbError: { code?: string; message: string } | null): string {
  if (!dbError) return ''
  if (dbError.code === '23514' || dbError.message?.includes('finance_payment_requests_approved_linked_requires_order_id')) {
    return 'Select a valid order before marking this payment as linked.'
  }
  return dbError.message
}

// ── Approval lock ─────────────────────────────────────────────────────────────
// Approval is the single hard locking point for this page. The two approved_*
// statuses are the Received Payments workflow's territory: approved_linked is
// already excluded from this page's query, and approved_unlinked still appears
// here (Order No. Pending tab) purely as history — view-only for everyone,
// including admins, who correct it from Received Payments instead.
//
// UNAPPROVED_STATUSES is also sent as a filter on every update/delete issued by
// this page, so the same rule is re-evaluated server-side against the committed
// row at mutation time (see the race note on APPROVED_RACE_MESSAGE).

const UNAPPROVED_STATUSES = ['pending_approval', 'needs_clarification', 'rejected'] as const

function isApproved(status: string): boolean {
  return status === 'approved_unlinked' || status === 'approved_linked'
}

// Shown when an update or delete matched zero rows because the request was
// approved after the modal was opened. The mutation is filtered on status
// server-side, so the approved record is never touched — the stale UI is.
const APPROVED_RACE_MESSAGE =
  'This request has already been approved and can no longer be changed here.'

const APPROVED_LOCK_NOTE =
  'This request has been approved and is now managed under Received Payments.'

// Who may act on a request from this page. Ownership and role are re-checked by
// RLS (finance_payment_requests_own_update / own_delete / admin_*) and by the
// approval guard triggers — this only decides which controls are worth showing.
function canManageRequest(r: PaymentRequest, isAdmin: boolean, userId: string): boolean {
  return !isApproved(r.status) && (isAdmin || r.submitted_by === userId)
}

// ── Age-based partitioning (Phase 2C) ─────────────────────────────────────────
// Rejected requests move from the active Rejected tab into Archive once they are
// at least 30 days old; needs_clarification requests older than 30 days show a
// (display-only) Stale badge. Age is measured from the DB-managed status-entry
// timestamps (rejected_at / clarification_requested_at). updated_at is only a
// defensive fallback for rows written before those columns existed (the
// migration backfills all current matching rows, so it should rarely apply).
//
// Boundary: archived/stale when the timestamp is at or before the cutoff
// (age >= 30d); active/normal when it is strictly after the cutoff (age < 30d).
// Null-safe: a row with no known timestamp is treated as active/not-stale so it
// can never silently vanish from the active view.

const ARCHIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

function archiveCutoff(): number {
  return Date.now() - ARCHIVE_WINDOW_MS
}

function isArchivedRejected(r: PaymentRequest, cutoff: number): boolean {
  if (r.status !== 'rejected') return false
  const ts = r.rejected_at ?? r.updated_at ?? null
  if (!ts) return false
  return new Date(ts).getTime() <= cutoff
}

function isStaleClarification(r: PaymentRequest, cutoff: number): boolean {
  if (r.status !== 'needs_clarification') return false
  const ts = r.clarification_requested_at ?? r.updated_at ?? null
  if (!ts) return false
  return new Date(ts).getTime() <= cutoff
}

function matchesTab(r: PaymentRequest, tab: FilterTab, cutoff: number): boolean {
  switch (tab) {
    case 'pending':       return r.status === 'pending_approval'
    case 'order_pending': return r.status === 'approved_unlinked'
    case 'clarification': return r.status === 'needs_clarification'
    case 'rejected':      return r.status === 'rejected' && !isArchivedRejected(r, cutoff)
    case 'archive':       return isArchivedRejected(r, cutoff)
    // 'all' shows active requests only: excludes approved_linked (the Received
    // Payments view) and excludes archived rejected, but keeps stale clarification.
    default:              return r.status !== 'approved_linked' && !isArchivedRejected(r, cutoff)
  }
}

// ── Shared modal shell ────────────────────────────────────────────────────────
// FinanceModal, RequestModalShell, and useModalScrollLockAndEscape live in
// src/app/finance/components/FinanceModalShell.tsx — shared with Received
// Payments so both pages use one Finance modal layering system.

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}{required && <span style={{ color: colors.red, marginLeft: '2px' }}>*</span>}
      </label>
      {children}
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px' }}>
      {message}
    </div>
  )
}

// Indian-grouped amount input. While focused it shows the raw, comma-free
// value for easy editing; on blur it displays Indian digit grouping. The
// canonical value passed to onChange is always comma-free numeric text.
function AmountInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false)
  const display = focused ? value : (value ? groupIndianDigits(value) : '')
  return (
    <input
      className="boe-input"
      type="text"
      inputMode="decimal"
      value={display}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={e => onChange(sanitizeAmountInput(e.target.value))}
      placeholder="0"
      style={{ width: '100%' }}
    />
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: '13px', color: colors.primary }}>{value}</span>
    </div>
  )
}

// Compact uppercase section label used throughout the details modal.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {children}
    </div>
  )
}

// Label-over-value metadata item; muted styling for empty/placeholder values.
function MetaItem({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ fontSize: '14px', color: muted ? colors.muted : colors.primary, wordBreak: 'break-word', lineHeight: 1.4 }}>{value}</span>
    </div>
  )
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

// Display-only indicator for a needs_clarification request that has been waiting
// at least 30 days. Purely visual — it never changes the request's status.
function StaleBadge() {
  return (
    <span style={{
      display: 'inline-block', marginLeft: '6px', padding: '2px 8px', borderRadius: '5px',
      background: '#FFF7ED', color: '#9A3412', border: '1px solid #FED7AA',
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      Stale
    </span>
  )
}

// ── Status correction options (admin) ────────────────────────────────────────
// approved_unlinked and approved_linked are deliberately excluded: those two
// states are order-linkage states, not review states, and must only be
// reached through approve_finance_payment_request, link_finance_payment_to_order,
// or unlink_finance_payment_from_order (20260690000000 / 20260691000000) — each
// locks the row and keeps status/order_id/order_number in lock-step. A generic
// correction here would let status diverge from order_id/order_number without
// any of those guarantees.

const STATUS_CORRECTION_OPTIONS: { value: string; label: string }[] = [
  { value: 'pending_approval',    label: 'Pending Review' },
  { value: 'needs_clarification', label: 'Needs Clarification' },
  { value: 'rejected',            label: 'Rejected' },
]

// ── Details modal (read-only for creators; includes status correction for admin) ──

function DetailsModal({
  request: r,
  onClose,
  isAdmin,
  userId,
  supabase,
  onCorrected,
  onEdit,
  onDelete,
}: {
  request: PaymentRequest
  onClose: () => void
  isAdmin?: boolean
  userId?: string
  supabase?: ReturnType<typeof createClient>
  onCorrected?: () => void
  onEdit?: (r: PaymentRequest) => void
  onDelete?: (r: PaymentRequest) => void
}) {
  // Order-linkage states are out of this control's jurisdiction entirely —
  // neither entering nor leaving approved_unlinked/approved_linked may happen
  // here, since either direction would move status without the RPCs' row
  // locking, eligibility checks, and order_id/order_number bookkeeping.
  const isLinkageStatus = isApproved(r.status)

  // Same rule the table's action buttons use, so the two surfaces can never
  // disagree about whether a request is still manageable from this page.
  const canManage = canManageRequest(r, !!isAdmin, userId ?? '')

  const [newStatus,       setNewStatus]       = useState(r.status)
  const [correctionNote,  setCorrectionNote]  = useState('')
  const [correcting,      setCorrecting]      = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)

  const noteRequiredForCorrection = newStatus === 'needs_clarification' || newStatus === 'rejected'
  const statusChanged = newStatus !== r.status
  const canCorrect = statusChanged && (!noteRequiredForCorrection || correctionNote.trim())

  const handleCorrect = async () => {
    if (!canCorrect || !supabase || !onCorrected) return
    setCorrecting(true)
    setCorrectionError(null)
    const { error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        status:     newStatus,
        admin_note: correctionNote.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id)
    setCorrecting(false)
    if (dbError) { setCorrectionError(friendlyDbErrorMessage(dbError)); return }

    // The status genuinely changed (canCorrect requires it) — tell the creator.
    void notifyFinance({
      event: 'finance_status_corrected',
      requestNumber: r.request_number,
      entityId: r.id,
      creatorId: r.submitted_by,
      clientName: r.client_name,
      statusLabel: STATUS_META[newStatus]?.label ?? newStatus,
    })

    onCorrected()
  }

  // Status-specific decision/clarification block. Shown only when a stored
  // admin_note exists; tinted with the request's own status colours.
  const decision = r.admin_note
    ? (() => {
        const m = STATUS_META[r.status] ?? { bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
        const title =
          r.status === 'rejected'            ? 'Rejection reason' :
          r.status === 'needs_clarification' ? 'Clarification required' :
          (isLinkageStatus)                  ? 'Approval note' :
                                               'Admin note'
        return { title, bg: m.bg, border: m.border, color: m.color, note: r.admin_note }
      })()
    : null

  const submittedLine = r.submitted_by_name
    ? `Submitted by ${r.submitted_by_name} · ${fmtDate(r.created_at)}`
    : `Submitted ${fmtDate(r.created_at)}`

  // Single "Payment Against" value for this modal only — deliberately not the
  // shared orderNoDisplay (that helper is also used by the Payments table and
  // the review modal). Collapses the old Payment Against + Order pair into one:
  // an existing/linked order shows its real number; a new-order request with
  // nothing created/linked yet shows a plain "New Order"; anything else falls
  // back to the existing safe helper for legacy/anomalous data.
  const paymentAgainstDisplay = r.order_number
    ? r.order_number
    : r.payment_against === 'new_order'
      ? 'New Order'
      : orderNoDisplay(r)

  const left = (
    <>
      {/* A. Primary summary card — amount + client lead, payment details below */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Amount</div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: colors.primary, lineHeight: 1.1, marginTop: '4px', fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>
              {fmtAmount(r.amount)}
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Client</div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: colors.primary, lineHeight: 1.3, marginTop: '4px', wordBreak: 'break-word' }}>
              {r.client_name}
            </div>
          </div>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px',
          borderTop: `1px solid ${colors.border}`, paddingTop: '14px',
        }}>
          <MetaItem label="Payment Date"    value={fmtDate(r.payment_date)} />
          <MetaItem label="Payment Against" value={paymentAgainstDisplay} muted={!r.order_number} />
          <MetaItem label="Payment Mode"    value={displayPaymentMode(r.payment_mode, r.received_in)} />
          <MetaItem label="Received In"     value={RECEIVED_IN_LABEL[r.received_in] ?? r.received_in} />
        </div>
      </div>

      {/* B. Decision block — compact status-tinted note, only when one exists */}
      {decision && (
        <div style={{ padding: '12px 14px', borderRadius: '10px', background: decision.bg, border: `1px solid ${decision.border}` }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: decision.color, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '5px' }}>
            {decision.title}
          </div>
          <div style={{ fontSize: '13.5px', color: decision.color, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {decision.note}
          </div>
        </div>
      )}

      {/* C. Proof and reference — one compact bordered block with two
          aligned rows. Proof uses the existing PaymentProofView (inline
          variant, so no nested card); reference shows the proof note or a
          muted placeholder. No large proof section, no duplication. */}
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0 }}>Proof</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {supabase
              ? <PaymentProofView supabase={supabase} paymentRequestId={r.id} renderEmpty inline />
              : <span style={{ fontSize: '13px', color: colors.muted }}>Not attached</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 12px', borderTop: `1px solid ${colors.border}` }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0, paddingTop: '1px' }}>Reference</span>
          <span style={{ fontSize: '13.5px', color: r.proof_note ? colors.primary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.45 }}>
            {r.proof_note || 'Not provided'}
          </span>
        </div>
      </div>

      {/* D. Notes — only when a sales note exists */}
      {r.sales_note && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <SectionHeader>Notes</SectionHeader>
          <div style={{ fontSize: '13.5px', color: colors.secondary, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {r.sales_note}
          </div>
        </div>
      )}
    </>
  )

  const right = (
    <>
      {/* E. Activity panel — subtle bordered panel; the timeline keeps its
          own "Activity" heading, query, ordering, and event text. */}
      {supabase && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px' }}>
          <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} />
        </div>
      )}

      {/* F. Admin controls — compact action panel. Never for
          approved_unlinked/approved_linked rows; those are managed only via
          Mark Payment Received, Link, and Unlink. */}
      {isAdmin && supabase && onCorrected && !isLinkageStatus && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px',
        }}>
          <div>
            <SectionHeader>Admin controls</SectionHeader>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px', lineHeight: 1.5 }}>
              Administrative correction. This action will be recorded in activity history.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <select
              className="boe-input"
              aria-label="Correct status"
              value={newStatus}
              onChange={e => { setNewStatus(e.target.value); setCorrectionNote(''); setCorrectionError(null) }}
              style={{ fontSize: '13px', maxWidth: '260px' }}
            >
              {STATUS_CORRECTION_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {!statusChanged && (
              <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
                Select a different status to make a correction.
              </div>
            )}
            {statusChanged && noteRequiredForCorrection && (
              <textarea
                className="boe-input"
                aria-label={newStatus === 'needs_clarification' ? 'Clarification note' : 'Rejection reason'}
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder={newStatus === 'needs_clarification' ? 'Clarification note (required)' : 'Rejection reason (required)'}
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
              />
            )}
            {statusChanged && !noteRequiredForCorrection && (
              <textarea
                className="boe-input"
                aria-label="Admin note"
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder="Admin note (optional)"
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
              />
            )}
            {correctionError && <ErrorBanner message={correctionError} />}
            {statusChanged && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={handleCorrect}
                  disabled={!canCorrect || correcting}
                  className="boe-btn boe-btn-primary"
                  style={{ padding: '7px 16px', fontSize: '13px' }}
                >
                  {correcting ? 'Saving…' : 'Save Correction'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Approved requests are view-only on this page for every role. The note
          says where the record now lives instead of offering a disabled
          control; the admin-only linkage sentence is kept alongside it. */}
      {isLinkageStatus && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          fontSize: '12px', color: colors.muted, lineHeight: 1.5,
        }}>
          {APPROVED_LOCK_NOTE}
          {isAdmin && ' Order linkage is managed there (Link / Unlink), not here.'}
        </div>
      )}
    </>
  )

  // Actions live in the shell's pinned footer so they stay reachable while the
  // body scrolls. Rendered only for a request this user may still act on — an
  // approved one gets the note above and no controls at all.
  const footer = canManage && (onEdit || onDelete) ? (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {onDelete && (
        <button
          onClick={() => onDelete(r)}
          style={{
            padding: '7px 16px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
            border: `1px solid ${colors.red}`, background: colors.redTint, color: colors.red, cursor: 'pointer',
          }}
        >
          Delete
        </button>
      )}
      {onEdit && (
        <button onClick={() => onEdit(r)} className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
          {!isAdmin && r.status === 'rejected' ? 'Reapply' : 'Edit'}
        </button>
      )}
    </div>
  ) : undefined

  return (
    <RequestModalShell
      requestNumber={r.request_number}
      submittedLine={submittedLine}
      statusBadge={<StatusBadge status={r.status} />}
      onClose={onClose}
      left={left}
      right={right}
      footer={footer}
    />
  )
}

// ── New Payment Confirmation modal ────────────────────────────────────────────

const EMPTY_FORM = {
  clientName:      '',
  amount:          '',
  paymentDate:     '',
  paymentMode:     PAYMENT_MODE_OPTIONS[0].value,
  receivedIn:      RECEIVED_IN_OPTIONS[0].value, // kept for DB compat; not shown in UI
  proofNote:       '',
  orderNumber:     '',
  salesNote:       '',
  paymentAgainst:  PAYMENT_AGAINST_OPTIONS[0].value,
}

type NewPaymentModalProps = {
  userId: string
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
  // Optional prefill, used when the form is opened from an Order Request so
  // the salesperson does not retype what that request already knows. Both are
  // ordinary editable field values — never a hidden linkage: a submitted
  // payment still has to be approved before it can be attached to anything.
  initialClientName?: string
  initialSalesNote?: string
  contextLabel?: string
}

function NewPaymentConfirmationModal({
  userId, supabase, onClose, onSaved,
  initialClientName, initialSalesNote, contextLabel,
}: NewPaymentModalProps) {
  useModalScrollLockAndEscape(onClose)
  const [form, setForm] = useState(() => ({
    ...EMPTY_FORM,
    clientName: initialClientName ?? EMPTY_FORM.clientName,
    salesNote:  initialSalesNote  ?? EMPTY_FORM.salesNote,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  // Optional payment-proof attachment (uploaded to the private payment-proofs bucket)
  const [attachFile,  setAttachFile]  = useState<File | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Order search — only used when payment_against = 'existing_order'
  const [orderQuery,     setOrderQuery]     = useState('')
  const [orderResults,   setOrderResults]   = useState<OrderResult[]>([])
  const [orderSearching, setOrderSearching] = useState(false)
  const [selectedOrder,  setSelectedOrder]  = useState<OrderResult | null>(null)

  const set = (key: keyof typeof EMPTY_FORM) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  // Order changed (selected, changed, or cleared) — Client Name always follows
  // the order for an existing-order request; no stale value survives a change.
  const selectOrder = (o: OrderResult | null) => {
    setSelectedOrder(o)
    setOrderResults([])
    setForm(prev => ({ ...prev, clientName: o?.client_name ?? '' }))
  }

  const handleOrderSearch = async (q: string) => {
    setOrderQuery(q)
    selectOrder(null)
    const trimmed = q.trim()
    if (!trimmed) { setOrderResults([]); return }
    setOrderSearching(true)
    const { data } = await supabase
      .from('orders')
      .select('id, display_number, client_name, total_value, status')
      .or(`display_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
      .not('status', 'in', '(cancelled)')
      .order('created_at', { ascending: false })
      .limit(20)
    setOrderResults((data ?? []) as OrderResult[])
    setOrderSearching(false)
  }

  const isExistingOrder = form.paymentAgainst === 'existing_order'
  const existingOrderClientName = selectedOrder?.client_name?.trim() ?? ''

  const canSubmit = !!(
    (isExistingOrder ? existingOrderClientName : form.clientName.trim()) &&
    isValidAmount(form.amount) &&
    form.paymentDate &&
    !attachError &&
    (!isExistingOrder || selectedOrder !== null)
  )

  // Uploads the selected proof to the private bucket and records its metadata.
  // Returns null on success, or an error string. On any failure it removes a
  // partially-uploaded object so no orphaned file remains; the CALLER is then
  // responsible for removing the payment request (and reserved order) it made,
  // so the user is never told success when the proof was not persisted.
  const persistProof = async (paymentRequestId: string): Promise<string | null> => {
    if (!attachFile) return null
    // Compression can change size/type, so re-validate the prepared file.
    const prepared = await compressImageFile(attachFile)
    const vErr = validateProofFile(prepared)
    if (vErr) return vErr

    // Upload under the type the bucket will actually accept. validateProofFile
    // guarantees this resolves, but fail closed rather than upload as octet-stream.
    const contentType = proofContentType(prepared)
    if (!contentType) return 'Only images (JPG, PNG, WEBP, GIF) or PDF files are allowed.'

    const path = buildProofPath(paymentRequestId, prepared.name)
    const { error: upErr } = await supabase.storage
      .from(PROOF_BUCKET)
      .upload(path, prepared, { upsert: false, contentType })
    if (upErr) return 'Could not upload the payment proof. Please try again.'

    const { error: metaErr } = await supabase
      .from('payment_proof_attachments')
      .insert({
        payment_request_id: paymentRequestId,
        storage_path:       path,
        file_name:          attachFile.name,
        file_type:          contentType,
        file_size:          prepared.size,
        created_by:         userId,
      })
    if (metaErr) {
      // Object uploaded but metadata failed — remove the object. The payment
      // request still exists here, so the storage delete policy authorizes this.
      await supabase.storage.from(PROOF_BUCKET).remove([path])
      return 'Could not save the payment proof. Please try again.'
    }
    return null
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)

    // Resolve UI payment mode to DB-safe values before any DB operation
    const dbMode = PAYMENT_MODE_DB_MAP[form.paymentMode]
    if (!dbMode) {
      setError('Invalid payment mode selected. Please choose a valid option.')
      setSaving(false)
      return
    }

    // The PNB destination is mapped to payment_mode='other' / received_in='other'.
    // Record the original intent in sales_note so the admin can see it.
    const baseNote = form.salesNote.trim()
    const finalSalesNote = form.paymentMode === 'hawala'
      ? [baseNote, 'Payment mode: PNB'].filter(Boolean).join(' | ') || null
      : baseNote || null

    // Existing order: client_name is the order's authoritative name, never the
    // (possibly stale/edited) form field — the DB trigger re-derives it from
    // order_id anyway, but sending the right value directly avoids relying on
    // that as anything but a backstop.
    //
    // New order: no order number is reserved or allocated here. The request is
    // saved with order_id/order_number = null; allocation happens only when an
    // admin approves it, via approve_finance_payment_request (20260688000000).
    const { data: created, error: dbError } = await supabase
      .from('finance_payment_requests')
      .insert({
        client_name:     isExistingOrder ? existingOrderClientName : form.clientName.trim(),
        amount:          Number(form.amount),
        payment_date:    form.paymentDate,
        payment_mode:    dbMode.payment_mode,
        received_in:     dbMode.received_in,
        proof_note:      form.proofNote.trim() || null,
        order_number:    isExistingOrder ? (selectedOrder?.display_number ?? null) : null,
        order_id:        isExistingOrder ? (selectedOrder?.id ?? null) : null,
        sales_note:      finalSalesNote,
        payment_against: form.paymentAgainst,
        status:          'pending_approval',
        submitted_by:    userId,
      })
      .select('id, request_number')
      .single()
    if (dbError || !created) { setError(dbError?.message ?? 'Failed to submit request.'); setSaving(false); return }

    const proofErr = await persistProof(created.id)
    if (proofErr) {
      // Compensation: don't leave a request claiming a proof that wasn't saved.
      // No order is ever created at submission time, so there is nothing else
      // to roll back here.
      const { error: delErr, count } = await supabase
        .from('finance_payment_requests')
        .delete({ count: 'exact' })
        .eq('id', created.id)
      const cleaned = !delErr && count !== 0
      setError(cleaned
        ? proofErr
        : `${proofErr} The draft request could not be cleaned up automatically — please ask an admin to remove the duplicate.`)
      setSaving(false)
      return
    }
    setSaving(false)

    // Notify approvers that a new request is waiting (non-blocking).
    void notifyFinance({
      event: 'finance_submitted',
      requestNumber: created.request_number,
      entityId: created.id,
      clientName: isExistingOrder ? existingOrderClientName : form.clientName.trim(),
    })

    onSaved()
  }

  const switchPaymentAgainst = (value: string) => {
    setForm(prev => ({ ...prev, paymentAgainst: value, clientName: '' }))
    setSelectedOrder(null)
    setOrderQuery('')
    setOrderResults([])
  }

  const isHandoverMode = form.paymentMode === 'cash_in_hand' || form.paymentMode === 'hawala'

  const SECTION_LABEL: React.CSSProperties = {
    fontSize: '10px', fontWeight: 700, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '10px',
  }

  return (
    <>
      {/* Full-page overlay */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: FINANCE_MODAL_OVERLAY_Z }}
      />

      {/* Modal */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: '660px', maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 40px)',
        background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
        zIndex: FINANCE_MODAL_DIALOG_Z, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>

        {/* ── Header ── */}
        <div style={{
          padding: '14px 20px 12px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>
              Send Payment Request
            </div>
            {contextLabel && (
              <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
                {contextLabel} · an admin approves it before it can be linked
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '13px', flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div style={{
          padding: '16px 20px', overflowY: 'auto', flex: 1,
          display: 'flex', flexDirection: 'column', gap: '14px',
        }}>

          {/* Section: Order */}
          <div>
            <div style={SECTION_LABEL}>Order</div>

            {/* Payment Against — two selectable cards */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
              {PAYMENT_AGAINST_OPTIONS.map(opt => {
                const active = form.paymentAgainst === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => switchPaymentAgainst(opt.value)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                      gap: '2px', padding: '8px 12px', borderRadius: '7px', cursor: 'pointer',
                      border: active ? '1.5px solid #DC1F2E' : `1px solid ${colors.border}`,
                      background: active ? 'rgba(220,31,46,0.04)' : colors.raised,
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 600, color: active ? '#DC1F2E' : colors.primary }}>
                      {opt.label}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Existing Order — search + selection */}
            {isExistingOrder && (
              <Field label="Select Order" required>
                {selectedOrder ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '7px 10px', borderRadius: '7px',
                    background: colors.blueTint, border: `1px solid rgba(85,133,232,0.25)`,
                  }}>
                    <div>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{selectedOrder.display_number}</span>
                      <span style={{ fontSize: '12px', color: colors.secondary, marginLeft: '8px' }}>{selectedOrder.client_name}</span>
                    </div>
                    <button
                      onClick={() => { selectOrder(null); setOrderQuery('') }}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                    >
                      Change
                    </button>
                  </div>
                ) : null}
                {selectedOrder && !existingOrderClientName && (
                  <ErrorBanner message="This order has no client name on file. Correct it on the Order Details page before submitting a payment request." />
                )}
                {!selectedOrder && (
                  <>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      background: colors.raised, border: `1px solid ${colors.border}`,
                      borderRadius: '6px', padding: '5px 10px',
                    }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        type="text"
                        autoFocus
                        placeholder="Search by order number or client…"
                        value={orderQuery}
                        onChange={e => handleOrderSearch(e.target.value)}
                        style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary }}
                      />
                      {orderSearching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
                    </div>
                    {orderResults.length > 0 && (
                      <div style={{
                        border: `1px solid ${colors.border}`, borderRadius: '7px', overflow: 'hidden',
                        maxHeight: '180px', overflowY: 'auto', marginTop: '4px',
                      }}>
                        {orderResults.map((o, idx) => {
                          const osMeta = ORDER_STATUS_META[o.status] ?? { label: o.status, color: colors.muted }
                          return (
                            <div
                              key={o.id}
                              onClick={() => selectOrder(o)}
                              style={{
                                padding: '8px 12px',
                                borderBottom: idx < orderResults.length - 1 ? `1px solid ${colors.border}` : 'none',
                                cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                              }}
                              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = colors.raised }}
                              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{o.display_number}</span>
                                  <span style={{ fontSize: '11px', fontWeight: 600, color: osMeta.color }}>{osMeta.label}</span>
                                </div>
                                <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {o.client_name}
                                </div>
                              </div>
                              {o.total_value != null && (
                                <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, flexShrink: 0 }}>
                                  {fmtAmount(o.total_value)}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {orderQuery.trim() && !orderSearching && orderResults.length === 0 && (
                      <div style={{ fontSize: '12px', color: colors.muted, padding: '6px 0' }}>
                        No orders found for &ldquo;{orderQuery.trim()}&rdquo;.
                      </div>
                    )}
                  </>
                )}
              </Field>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>

            {/* Row 1: Client Name + Amount */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <Field label="Client Name" required>
                  {isExistingOrder ? (
                    <>
                      <input className="boe-input" value={existingOrderClientName} readOnly disabled
                        placeholder="Select an order first" style={{ width: '100%' }} />
                      <span style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
                        Client name is taken from the selected order.
                      </span>
                    </>
                  ) : (
                    <input className="boe-input" value={form.clientName} onChange={set('clientName')}
                      placeholder="e.g. Raj Enterprises" style={{ width: '100%' }} />
                  )}
                </Field>
                <Field label="Amount (₹)" required>
                  <AmountInput value={form.amount} onChange={v => setForm(prev => ({ ...prev, amount: v }))} />
                </Field>
              </div>

              {/* Row 2: Payment Date + Payment Mode */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <Field label="Payment Date" required>
                  <input className="boe-input" type="date" value={form.paymentDate}
                    onChange={set('paymentDate')} style={{ width: '100%' }} />
                </Field>
                <Field label="Payment Mode" required>
                  <select className="boe-input" value={form.paymentMode} onChange={set('paymentMode')} style={{ width: '100%' }}>
                    {PAYMENT_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
              </div>

              {/* Conditional: Cash / handover note */}
              {isHandoverMode && (
                <Field label="Cash / handover note">
                  <input
                    className="boe-input"
                    value={form.salesNote}
                    onChange={set('salesNote')}
                    placeholder="Who collected cash or handover detail"
                    style={{ width: '100%' }}
                  />
                </Field>
              )}

              {/* Proof row: reference input + attachment (optional) */}
              <Field label="Payment Proof / Reference">
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    className="boe-input"
                    value={form.proofNote}
                    onChange={set('proofNote')}
                    placeholder="UTR, cheque no., or short proof note (optional)"
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.pdf"
                    style={{ display: 'none' }}
                    onChange={e => {
                      const f = e.target.files?.[0] ?? null
                      if (!f) { setAttachFile(null); setAttachError(null); return }
                      const vErr = validateProofFile(f)
                      if (vErr) {
                        setAttachFile(null)
                        setAttachError(vErr)
                        if (fileInputRef.current) fileInputRef.current.value = ''
                        return
                      }
                      setAttachError(null)
                      setAttachFile(f)
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '6px 10px', fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    {attachFile ? '📎 ' + attachFile.name.slice(0, 14) + (attachFile.name.length > 14 ? '…' : '') : '📎 Attach'}
                  </button>
                </div>
                {attachError && (
                  <span style={{ fontSize: '11px', color: colors.red, marginTop: '2px' }}>{attachError}</span>
                )}
                {attachFile && !attachError && (
                  <span style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
                    Attached: {attachFile.name} — proof is optional and stored privately.
                  </span>
                )}
              </Field>

          </div>

          {error && <ErrorBanner message={error} />}

        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: '10px 20px', borderTop: `1px solid ${colors.border}`,
          display: 'flex', gap: '8px', justifyContent: 'flex-end', flexShrink: 0,
        }}>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!canSubmit || saving}
            className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
            {saving ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>

      </div>
    </>
  )
}

// ── Edit Payment modal (creator only) ────────────────────────────────────────

type EditPaymentModalProps = {
  request: PaymentRequest
  isAdmin: boolean
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
}

function EditPaymentModal({ request: r, isAdmin, supabase, onClose, onSaved }: EditPaymentModalProps) {
  const [form, setForm] = useState({
    clientName:  r.client_name,
    amount:      String(r.amount),
    paymentDate: r.payment_date,
    paymentMode: dbToUiPaymentMode(r.payment_mode, r.received_in),
    proofNote:   r.proof_note ?? '',
    orderNumber: r.order_number ?? '',
    salesNote:   r.sales_note  ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const isExistingOrder = r.payment_against === 'existing_order'

  // Set once an approval was detected mid-edit: the request is gone from this
  // page's jurisdiction, so retrying the save can only fail the same way.
  const [stale, setStale] = useState(false)

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const canSubmit = form.clientName.trim() && isValidAmount(form.amount) && form.paymentDate

  const handleSave = async () => {
    if (!canSubmit) return
    const editDbMode = PAYMENT_MODE_DB_MAP[form.paymentMode]
    if (!editDbMode) {
      setError('Invalid payment mode selected.')
      return
    }
    setSaving(true)
    setError(null)
    // order_number stays in the payload unconditionally: this modal now only
    // ever opens for an unapproved request, where order_number is free-form
    // reference text and order_id is untouched. For the two approved_* states
    // it is owned by the link/unlink RPCs — and those rows can no longer reach
    // this form at all (canManageRequest), nor survive the status filter below.
    const isCreatorReapply = !isAdmin && (r.status === 'needs_clarification' || r.status === 'rejected')

    // The status filter is the race guard: PostgREST re-evaluates it against
    // the committed row, so an approval that landed while this modal was open
    // turns the save into a zero-row no-op instead of overwriting the approved
    // record. It applies to admins too, whose RLS policy alone would allow the
    // write. Nothing protected is submitted: request_number, submitted_by,
    // approved_by/at, created_at, order_id and the linkage columns are all
    // absent from the payload.
    const { data: updated, error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        client_name:  form.clientName.trim(),
        amount:       Number(form.amount),
        payment_date: form.paymentDate,
        payment_mode: editDbMode.payment_mode,
        received_in:  editDbMode.received_in,
        proof_note:   form.proofNote.trim() || null,
        order_number: form.orderNumber.trim() || null,
        sales_note:   form.salesNote.trim() || null,
        ...(isCreatorReapply ? { status: 'pending_approval' } : {}),
        updated_at:   new Date().toISOString(),
      })
      .eq('id', r.id)
      .in('status', UNAPPROVED_STATUSES)
      .select('id')
      .maybeSingle()
    setSaving(false)
    if (dbError) { setError(friendlyDbErrorMessage(dbError)); return }
    if (!updated) { setStale(true); setError(APPROVED_RACE_MESSAGE); return }

    // A creator editing a needs_clarification or rejected request moves it
    // back to pending_approval — notify approvers it is ready for review again.
    if (isCreatorReapply) {
      void notifyFinance({
        event: 'finance_resubmitted',
        requestNumber: r.request_number,
        entityId: r.id,
        clientName: form.clientName.trim(),
      })
    }

    onSaved()
  }

  return (
    // Once an approval has been detected, every dismissal path refreshes so the
    // table stops showing the request as still editable (see the same note on
    // DeleteConfirmModal).
    <FinanceModal title={!isAdmin && r.status === 'rejected' ? 'Reapply Payment Request' : 'Edit Payment Request'} onClose={stale ? onSaved : onClose}>
      {!isAdmin && r.status === 'needs_clarification' && (
        <div style={{
          padding: '12px 14px', borderRadius: '8px',
          background: '#EFF6FF', border: '1px solid #BFDBFE',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#1E40AF', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: r.admin_note ? '6px' : '0' }}>
            Clarification Required
          </div>
          {r.admin_note && (
            <div style={{ fontSize: '13px', color: '#1E3A8A', lineHeight: 1.6, marginBottom: '6px' }}>{r.admin_note}</div>
          )}
          <div style={{ fontSize: '11px', color: '#3B82F6', marginTop: '4px' }}>
            Saving your changes will resubmit this request for admin review.
          </div>
        </div>
      )}
      {!isAdmin && r.status === 'rejected' && (
        <div style={{
          padding: '12px 14px', borderRadius: '8px',
          background: '#FEF2F2', border: '1px solid #FECACA',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#991B1B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: r.admin_note ? '6px' : '0' }}>
            Rejection Reason
          </div>
          {r.admin_note && (
            <div style={{ fontSize: '13px', color: '#7F1D1D', lineHeight: 1.6, marginBottom: '6px' }}>{r.admin_note}</div>
          )}
          <div style={{ fontSize: '11px', color: '#DC2626', marginTop: '4px' }}>
            Saving your changes will reapply this request for admin review. The rejection above stays visible in Activity history.
          </div>
        </div>
      )}
      <Field label="Client Name" required>
        {isExistingOrder ? (
          <>
            <input className="boe-input" value={form.clientName} readOnly disabled style={{ width: '100%' }} />
            <span style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
              Client name is taken from the selected order.
            </span>
          </>
        ) : (
          <input className="boe-input" value={form.clientName} onChange={set('clientName')}
            placeholder="e.g. Raj Enterprises" style={{ width: '100%' }} />
        )}
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Field label="Amount (₹)" required>
          <AmountInput value={form.amount} onChange={v => setForm(prev => ({ ...prev, amount: v }))} />
        </Field>
        <Field label="Payment Date" required>
          <input className="boe-input" type="date" value={form.paymentDate}
            onChange={set('paymentDate')} style={{ width: '100%' }} />
        </Field>
      </div>
      <Field label="Payment Mode" required>
        <select className="boe-input" value={form.paymentMode} onChange={set('paymentMode')} style={{ width: '100%' }}>
          {PAYMENT_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field label="Payment Proof / Reference Note">
        <textarea className="boe-input" value={form.proofNote} onChange={set('proofNote')}
          placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office (optional)"
          rows={2} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      <Field label="Order Number (optional)">
        <input className="boe-input" value={form.orderNumber} onChange={set('orderNumber')}
          placeholder="Leave blank if order not yet created" style={{ width: '100%' }} />
      </Field>
      <Field label="Sales Note (optional)">
        <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
          placeholder="Any additional context for admin"
          rows={2} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      {error && <ErrorBanner message={error} />}
      {/* Once an approval has been detected there is nothing left to save here,
          so the form's actions collapse to a single dismissal that also
          refreshes the table (onSaved) — never a retry that must fail again. */}
      {stale ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onSaved} className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Close
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
          <button onClick={handleSave} disabled={!canSubmit || saving}
            className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
            {!isAdmin && r.status === 'rejected'
              ? (saving ? 'Reapplying…' : 'Save & Reapply')
              : (saving ? 'Saving…' : 'Save Changes')}
          </button>
        </div>
      )}
    </FinanceModal>
  )
}

// ── Admin Review modal ────────────────────────────────────────────────────────

type AdminReviewModalProps = {
  request: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onActioned: () => void
}

function AdminReviewModal({ request: r, supabase, onClose, onActioned }: AdminReviewModalProps) {
  const [action,    setAction]    = useState<AdminAction | null>(null)
  const [adminNote, setAdminNote] = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const noteRequired = action === 'needs_clarification' || action === 'reject'
  const canConfirm   = action !== null && (!noteRequired || adminNote.trim())

  const handleConfirm = async () => {
    if (!action) return
    setSaving(true)
    setError(null)

    if (action === 'approve') {
      // Confirming receipt never creates an order — see
      // approve_finance_payment_request in 20260690000000. A new_order
      // request always lands in approved_unlinked (Suspense) with order_id
      // left null; an existing_order request links straight to the order it
      // already carries. The client never allocates or chooses an order
      // number either way.
      const { error: rpcError } = await supabase.rpc('approve_finance_payment_request', {
        p_request_id: r.id,
        p_admin_note: adminNote.trim() || null,
      })
      setSaving(false)
      if (rpcError) { setError(friendlyDbErrorMessage(rpcError)); return }

      // A new_order request lands in Suspense; an existing_order request links
      // straight to its order — notify the creator with the matching wording.
      void notifyFinance(
        r.payment_against === 'new_order'
          ? { event: 'finance_approved_suspense', requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name }
          : { event: 'finance_approved_linked',   requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name, orderNumber: r.order_number },
      )

      onActioned()
      return
    }

    const { error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        admin_note: adminNote.trim() || null,
        status:     action === 'needs_clarification' ? 'needs_clarification' : 'rejected',
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id)
    setSaving(false)
    if (dbError) { setError(friendlyDbErrorMessage(dbError)); return }

    // Notify the creator of the outcome (non-blocking).
    void notifyFinance({
      event: action === 'needs_clarification' ? 'finance_clarification' : 'finance_rejected',
      requestNumber: r.request_number,
      entityId: r.id,
      creatorId: r.submitted_by,
      clientName: r.client_name,
    })

    onActioned()
  }

  const actionBtn = (a: AdminAction, label: string, activeColor: string, activeBg: string): React.CSSProperties => {
    const active = action === a
    return {
      padding: '7px 16px', fontSize: '12px', fontWeight: 600, borderRadius: '7px', cursor: 'pointer',
      border: `1px solid ${active ? activeColor : colors.border}`,
      background: active ? activeBg : 'transparent',
      color: active ? activeColor : colors.secondary,
    }
  }

  const submittedLine = r.submitted_by_name
    ? `Submitted by ${r.submitted_by_name} · ${fmtDate(r.created_at)}`
    : `Submitted ${fmtDate(r.created_at)}`

  const left = (
    <>
      {/* Primary summary card — amount + client lead, payment details below.
          Same shell as the detail modal's card, with Order Number added since
          the reviewer (unlike the read-only view) needs it alongside Payment
          Against to judge an approve action. */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Amount</div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: colors.primary, lineHeight: 1.1, marginTop: '4px', fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>
              {fmtAmount(r.amount)}
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Client</div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: colors.primary, lineHeight: 1.3, marginTop: '4px', wordBreak: 'break-word' }}>
              {r.client_name}
            </div>
          </div>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px',
          borderTop: `1px solid ${colors.border}`, paddingTop: '14px',
        }}>
          <MetaItem label="Payment Date"    value={fmtDate(r.payment_date)} />
          <MetaItem label="Payment Against" value={PAYMENT_AGAINST_LABEL[r.payment_against] ?? r.payment_against} />
          <MetaItem label="Payment Mode"    value={displayPaymentMode(r.payment_mode, r.received_in)} />
          <MetaItem label="Received In"     value={RECEIVED_IN_LABEL[r.received_in] ?? r.received_in} />
          <MetaItem label="Order Number"    value={orderNoDisplay(r)} muted={!r.order_number} />
        </div>
      </div>

      {/* Proof and reference — same compact bordered block as the detail modal. */}
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0 }}>Proof</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <PaymentProofView supabase={supabase} paymentRequestId={r.id} renderEmpty inline />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 12px', borderTop: `1px solid ${colors.border}` }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0, paddingTop: '1px' }}>Reference</span>
          <span style={{ fontSize: '13.5px', color: r.proof_note ? colors.primary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.45 }}>
            {r.proof_note || 'Not provided'}
          </span>
        </div>
      </div>

      {/* Notes — only when a sales note exists */}
      {r.sales_note && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <SectionHeader>Notes</SectionHeader>
          <div style={{ fontSize: '13.5px', color: colors.secondary, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {r.sales_note}
          </div>
        </div>
      )}
    </>
  )

  const right = (
    <>
      {/* Activity panel — same bordered shell as the detail modal. */}
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px' }}>
        <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} />
      </div>

      {/* Review panel — action selection, admin note, and the confirm/cancel
          controls that carry out the review. Business logic (RPC call for
          approve, status update for clarification/rejection, notifications)
          is unchanged from before this modal's layout was reworked. */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
        display: 'flex', flexDirection: 'column', gap: '12px',
      }}>
        <SectionHeader>Review</SectionHeader>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Action</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button style={actionBtn('approve', 'Mark Payment Received', colors.green, colors.greenTint)} onClick={() => setAction('approve')}>Mark Payment Received</button>
            <button style={actionBtn('needs_clarification','Needs Clarification',colors.blue,  colors.blueTint)}  onClick={() => setAction('needs_clarification')}>Needs Clarification</button>
            <button style={actionBtn('reject',             'Reject',             colors.red,   colors.redTint)}   onClick={() => setAction('reject')}>Reject</button>
          </div>
        </div>

        {action === 'approve' && (
          <div style={{
            padding: '10px 12px', borderRadius: '8px',
            background: r.payment_against === 'new_order' ? '#FFF7ED' : '#F0FDF4',
            border: `1px solid ${r.payment_against === 'new_order' ? '#FED7AA' : '#BBF7D0'}`,
            fontSize: '12px', color: r.payment_against === 'new_order' ? '#9A3412' : '#166534',
            lineHeight: 1.5,
          }}>
            {r.payment_against === 'new_order'
              ? 'This payment will be recorded as received and moved to Suspense. No order or order number is created here — attach it to an order later from Order Requests or the Suspense list.'
              : `This payment will be linked directly to order ${r.order_number ?? orderNoDisplay(r)}.`}
          </div>
        )}

        {action && (
          <Field label={`Admin Note${noteRequired ? '' : ' (optional)'}`} required={noteRequired}>
            <textarea className="boe-input" value={adminNote} onChange={e => setAdminNote(e.target.value)}
              placeholder={
                action === 'approve'             ? 'Optional note for the salesperson' :
                action === 'needs_clarification' ? 'Explain what clarification is needed' :
                                                   'Explain why this is being rejected'
              }
              rows={2} style={{ width: '100%', resize: 'vertical', fontSize: '13px' }} />
          </Field>
        )}

        {error && <ErrorBanner message={error} />}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>Cancel</button>
          <button onClick={handleConfirm} disabled={!canConfirm || saving}
            className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
            {saving ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </>
  )

  return (
    <RequestModalShell
      requestNumber={r.request_number}
      submittedLine={submittedLine}
      statusBadge={<StatusBadge status={r.status} />}
      onClose={onClose}
      left={left}
      right={right}
    />
  )
}

// ── Delete confirm modal (admin only) ────────────────────────────────────────

type DeleteConfirmModalProps = {
  request: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onDeleted: () => void
}

function DeleteConfirmModal({ request: r, supabase, onClose, onDeleted }: DeleteConfirmModalProps) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  // Set once the outcome is final and the confirmation is spent — either the
  // request was approved mid-flight (nothing was deleted) or it was deleted but
  // its proof file could not be removed. Both collapse the footer to a single
  // dismissal that refreshes the table; neither offers a retry that can help.
  const [settled, setSettled]   = useState(false)
  const [warning, setWarning]   = useState<string | null>(null)
  const meta = STATUS_META[r.status] ?? { label: r.status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)

    // 1. Read the proof paths first: payment_proof_attachments cascades with
    //    the request, so after the delete there is nothing left to read them
    //    from. Only this request's own attachments are collected, so a file
    //    belonging to any other record can never be touched.
    const { data: proofs, error: proofErr } = await supabase
      .from('payment_proof_attachments')
      .select('storage_path')
      .eq('payment_request_id', r.id)
    if (proofErr) {
      setDeleting(false)
      setError('Could not read this request’s proof attachments. Nothing was deleted — please try again.')
      return
    }

    // 2. Delete the request itself, filtered on status. RLS re-evaluates that
    //    filter against the committed row, so an approval landing while this
    //    modal was open makes this a zero-row no-op rather than destroying an
    //    approved payment. The request goes first deliberately: deleting the
    //    proof object first would destroy the evidence for a payment that then
    //    turned out to be un-deletable.
    const { error: dbError, count } = await supabase
      .from('finance_payment_requests')
      .delete({ count: 'exact' })
      .eq('id', r.id)
      .in('status', UNAPPROVED_STATUSES)
    if (dbError) { setDeleting(false); setError(friendlyDbErrorMessage(dbError)); return }
    if (count === 0) { setDeleting(false); setSettled(true); setError(APPROVED_RACE_MESSAGE); return }

    // 3. The request is gone; remove its now-orphaned proof objects. Authorized
    //    by the parent-less branch of the payment_proofs_delete storage policy
    //    (20260700000000). A failure here cannot be retried usefully and must
    //    not be reported as a clean success.
    const paths = ((proofs ?? []) as { storage_path: string }[])
      .map(p => p.storage_path)
      .filter(Boolean)
    if (paths.length > 0) {
      const { data: removed, error: rmErr } = await supabase.storage.from(PROOF_BUCKET).remove(paths)
      if (rmErr || (removed?.length ?? 0) < paths.length) {
        setDeleting(false)
        setSettled(true)
        setWarning(`Payment request ${r.request_number} was deleted, but its proof file could not be removed from storage. Please ask an admin to delete it from the payment-proofs bucket.`)
        return
      }
    }

    setDeleting(false)
    onDeleted()
  }

  return (
    // Once settled, EVERY dismissal path (✕, Escape, overlay click, the Close
    // button) must refresh the table — in the partial-success case the request
    // really is gone, and a plain close would leave a deleted row on screen
    // that reports "already approved" if Delete is clicked again.
    <FinanceModal title="Delete Payment Request" onClose={settled ? onDeleted : onClose}>
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.7 }}>
        Delete this Payment Request? This action cannot be undone.
      </div>
      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '12px 14px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px',
        border: `1px solid ${colors.border}`,
      }}>
        <DetailRow label="Request"      value={r.request_number} />
        <DetailRow label="Client"       value={r.client_name} />
        <DetailRow label="Amount"       value={fmtAmount(r.amount)} />
        <DetailRow label="Payment Date" value={fmtDate(r.payment_date)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</span>
          <span style={{
            display: 'inline-block', padding: '2px 8px', borderRadius: '5px', alignSelf: 'flex-start',
            background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
            fontSize: '11px', fontWeight: 600,
          }}>
            {meta.label}
          </span>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {warning && (
        <div style={{ padding: '10px 12px', borderRadius: '8px', background: '#FFF7ED', border: '1px solid #FED7AA', color: '#9A3412', fontSize: '12px', lineHeight: 1.55 }}>
          {warning}
        </div>
      )}
      {settled ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onDeleted} className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Close
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
              border: `1px solid ${colors.red}`, background: colors.redTint, color: colors.red,
              cursor: deleting ? 'default' : 'pointer', opacity: deleting ? 0.6 : 1,
            }}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}
    </FinanceModal>
  )
}

// ── Payments table ────────────────────────────────────────────────────────────

const TH_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: '10px',
  fontWeight: 700,
  color: colors.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
  borderBottom: `1px solid ${colors.border}`,
  background: colors.raised,
}

function PaymentsTable({
  rows,
  isAdmin,
  userId,
  cutoff,
  highlightId,
  onRowClick,
  onView,
  onEdit,
  onDelete,
}: {
  rows: PaymentRequest[]
  isAdmin: boolean
  userId: string
  cutoff: number
  highlightId?: string | null
  onRowClick: (r: PaymentRequest) => void
  onView: (r: PaymentRequest) => void
  onEdit: (r: PaymentRequest) => void
  onDelete: (r: PaymentRequest) => void
}) {
  const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }

  return (
    // overflowX:auto is retained only as a narrow-mobile fallback; at desktop
    // width the compact 8-column set fits without scrolling (no forced minWidth).
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>Request</th>
            <th style={TH_STYLE}>Client</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Amount</th>
            <th style={TH_STYLE}>Payment Date</th>
            <th style={TH_STYLE}>Against</th>
            <th style={TH_STYLE}>Status</th>
            <th style={TH_STYLE}>Requested By</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isPending  = r.status === 'pending_approval'
            const isClarif   = r.status === 'needs_clarification'
            const isRejected = r.status === 'rejected'
            const accentColor =
              isPending  ? '#F59E0B' :
              isClarif   ? colors.blue :
              isRejected ? colors.red :
              'transparent'

            // Approved requests are view-only here for everyone, admins
            // included — they belong to Received Payments from that point on.
            const canManage   = canManageRequest(r, isAdmin, userId)
            const showReapply = canManage && !isAdmin && isRejected
            const showEdit    = canManage && !showReapply
            const showDelete  = canManage
            const isHighlighted = r.id === highlightId

            return (
              <tr
                key={r.id}
                id={`payment-row-${r.id}`}
                onClick={() => onRowClick(r)}
                style={{ cursor: 'pointer', borderLeft: `3px solid ${accentColor}`, background: isHighlighted ? colors.amberTint : undefined }}
                onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = isHighlighted ? colors.amberTint : 'transparent' }}
              >
                <td style={{ ...TD, fontSize: '11px', color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {r.request_number}
                </td>
                <td style={TD}>
                  {/* Client truncates instead of widening the table; full name via title. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', maxWidth: '220px' }}>
                    <span
                      title={r.client_name}
                      style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px', fontWeight: 600, color: colors.primary }}
                    >
                      {r.client_name}
                    </span>
                    {isAdmin && isPending && (
                      <span style={{
                        flexShrink: 0, fontSize: '10px', fontWeight: 600,
                        color: '#92400E', background: '#FEF3C7',
                        padding: '1px 5px', borderRadius: '4px',
                      }}>
                        Review
                      </span>
                    )}
                  </div>
                </td>
                <td style={{ ...TD, fontSize: '13px', fontWeight: 700, color: colors.primary, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtAmount(r.amount)}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {fmtDate(r.payment_date)}
                </td>
                <td style={TD}>
                  {/* Order number when present, else the existing new-order/suspense
                      wording (orderNoDisplay) — truncated with full text via title. */}
                  <div
                    title={orderNoDisplay(r)}
                    style={{ maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: r.order_number ? colors.secondary : colors.muted, fontStyle: r.order_number ? 'normal' : 'italic' }}
                  >
                    {orderNoDisplay(r)}
                  </div>
                </td>
                <td style={TD}>
                  <StatusBadge status={r.status} />
                  {isStaleClarification(r, cutoff) && <StaleBadge />}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  <div
                    title={r.submitted_by_name ?? undefined}
                    style={{ maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {r.submitted_by_name ?? '—'}
                  </div>
                </td>
                <td style={{ ...TD, textAlign: 'right' }}>
                  <div
                    style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <button
                      onClick={() => onView(r)}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                    >
                      View
                    </button>
                    {showEdit && (
                      <button
                        onClick={() => onEdit(r)}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                      >
                        Edit
                      </button>
                    )}
                    {showReapply && (
                      <button
                        onClick={() => onEdit(r)}
                        className="boe-btn boe-btn-primary"
                        style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                      >
                        Reapply
                      </button>
                    )}
                    {showDelete && (
                      <button
                        onClick={() => onDelete(r)}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.red }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <FinancePageInner />
    </Suspense>
  )
}

function FinancePageInner() {
  const [pageLoading, setPageLoading]   = useState(true)
  const [userId, setUserId]             = useState<string>('')
  const [isAdmin, setIsAdmin]           = useState(false)
  const [profile, setProfile]           = useState<UserProfile | null>(null)
  const [requests, setRequests]         = useState<PaymentRequest[]>([])
  const [listLoading, setListLoading]   = useState(false)
  const [showForm, setShowForm]           = useState(false)
  // Prefill carried in from another module's "Add Payment" action (currently
  // the Order Requests details modal). Cleared with the form, so the plain
  // "+ New" button always opens an empty one.
  const [formPrefill, setFormPrefill]     = useState<{ clientName: string; salesNote: string; contextLabel: string } | null>(null)
  const [reviewRequest, setReviewRequest] = useState<PaymentRequest | null>(null)
  const [detailRequest, setDetailRequest] = useState<PaymentRequest | null>(null)
  const [editRequest,   setEditRequest]   = useState<PaymentRequest | null>(null)
  const [deleteRequest, setDeleteRequest] = useState<PaymentRequest | null>(null)
  const [search, setSearch]             = useState('')
  const [highlightId, setHighlightId]   = useState<string | null>(null)

  const router       = useRouter()
  const supabase     = useMemo(() => createClient(), [])
  const searchParams = useSearchParams()

  // ?tab= from the Admin Action Queue selects the initial tab; manual tab
  // clicks below still just call setActiveTab and are otherwise untouched.
  const [activeTab, setActiveTab] = useState<FilterTab>(() => parseFilterTab(searchParams.get('tab')))

  // Guards the one-time ?request= deep-link resolution below so it can never
  // re-fire (StrictMode double-invoke, unrelated rerenders) and reopen a
  // modal the admin already closed.
  const deepLinkHandled = useRef(false)

  // ── Fetch — join submitted_by_name via users ─────────────────────────────────
  const loadRequests = async () => {
    setListLoading(true)
    const { data } = await supabase
      .from('finance_payment_requests')
      .select(`
        id, request_number, client_name, amount, payment_date, payment_mode,
        received_in, proof_note, order_number, order_id, sales_note,
        payment_against, status, submitted_by, admin_note, created_at,
        updated_at, rejected_at, clarification_requested_at,
        submitted_by_user:users!submitted_by(full_name)
      `)
      .neq('status', 'approved_linked')
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: PaymentRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      submitted_by_name: r.submitted_by_user?.full_name ?? undefined,
      submitted_by_user: undefined,
    }))
    setRequests(mapped)
    setListLoading(false)
  }

  // ── Auth + profile ───────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const uid = session.user.id
      setUserId(uid)

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
        .eq('id', uid)
        .single()

      setProfile(me as UserProfile)
      setIsAdmin(me?.role === 'admin')
      await loadRequests()
      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Deep-link resolution (Admin Action Queue → ?tab=&request=) ───────────────
  // Runs exactly once, once `requests` is loaded. A missing, invalid, or
  // no-longer-pending id is a silent no-op — the normal tab still renders,
  // no fatal error, no claim that the action is still available.
  useEffect(() => {
    const resolveDeepLink = () => {
      if (pageLoading || deepLinkHandled.current) return
      deepLinkHandled.current = true

      // ?new=1[&client=&note=] — another module asked for a new payment request
      // against a client it already knows. Opens THIS page's own submission
      // form prefilled; nothing is created until the user submits it here.
      if (searchParams.get('new') === '1') {
        const client = searchParams.get('client')?.trim() ?? ''
        const note   = searchParams.get('note')?.trim() ?? ''
        setFormPrefill({ clientName: client, salesNote: note, contextLabel: note })
        setShowForm(true)
        router.replace('/finance')
        return
      }

      const requestId = searchParams.get('request')
      if (requestId) {
        const match = requests.find(r => r.id === requestId)
        if (match) {
          setHighlightId(match.id)
          setTimeout(() => setHighlightId(null), 3000)
          document.getElementById(`payment-row-${match.id}`)?.scrollIntoView({ block: 'center' })
          if (isAdmin && match.status === 'pending_approval') {
            setReviewRequest(match)
          } else {
            setDetailRequest(match)
          }
        }
        // Drop the record param so a refresh or back-navigation can't reopen
        // the modal; keep the tab so the deep link still lands correctly.
        router.replace(`/finance?tab=${activeTab}`)
      }
    }
    resolveDeepLink()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLoading])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // ── Filtered + searched list (client-side, newest-first already from DB) ─────
  const visible = useMemo(() => {
    const cutoff = archiveCutoff()
    let list = requests.filter(r => matchesTab(r, activeTab, cutoff))
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(r =>
        r.client_name.toLowerCase().includes(q) ||
        (r.order_number ?? '').toLowerCase().includes(q)
      )
    }
    return list
  }, [requests, activeTab, search])

  // ── Status counts (across all unfiltered) ────────────────────────────────────
  const counts = useMemo(() => {
    const cutoff = archiveCutoff()
    return {
      pending:       requests.filter(r => r.status === 'pending_approval').length,
      order_pending: requests.filter(r => r.status === 'approved_unlinked').length,
      clarification: requests.filter(r => r.status === 'needs_clarification').length,
      rejected:      requests.filter(r => r.status === 'rejected' && !isArchivedRejected(r, cutoff)).length,
      archive:       requests.filter(r => isArchivedRejected(r, cutoff)).length,
      all:           requests.filter(r => r.status !== 'approved_linked' && !isArchivedRejected(r, cutoff)).length,
    }
  }, [requests])

  const tabCount: Record<FilterTab, number> = {
    pending:       counts.pending,
    order_pending: counts.order_pending,
    clarification: counts.clarification,
    rejected:      counts.rejected,
    archive:       counts.archive,
    all:           counts.all,
  }

  // ── Row click handler ────────────────────────────────────────────────────────
  const handleRowClick = (r: PaymentRequest) => {
    if (isAdmin && r.status === 'pending_approval') {
      setReviewRequest(r)
    } else {
      setDetailRequest(r)
    }
  }

  if (pageLoading) return <LoadingScreen />

  return (
    <FinanceLayout
      profile={profile}
      title="Payment Requests"
      subtitle="Sales can submit customer payment details here for admin approval."
      onSignOut={handleSignOut}
      onRefresh={loadRequests}
      actions={
        <button onClick={() => { setFormPrefill(null); setShowForm(true) }} className="boe-btn boe-btn-primary"
          style={{ padding: '6px 14px', fontSize: '12px' }}>
          + New
        </button>
      }
    >
      <div className="boe-card" style={{ overflow: 'hidden' }}>

        {/* ── Filter tabs + search ── */}
        <div style={{ padding: '10px 16px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {FILTER_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setSearch('') }}
              className={`boe-filter-tab${activeTab === tab.key ? ' boe-filter-tab-active' : ''}`}
            >
              {tab.label}
              {tabCount[tab.key] > 0 && (
                <span style={{
                  marginLeft: '5px',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: '16px', height: '16px', borderRadius: '4px',
                  background: activeTab === tab.key ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.08)',
                  fontSize: '10px', fontWeight: 700,
                }}>
                  {tabCount[tab.key]}
                </span>
              )}
            </button>
          ))}

          {/* Search — right-aligned */}
          <div style={{
            marginLeft: 'auto',
            display: 'flex', alignItems: 'center', gap: '6px',
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: '6px', padding: '5px 10px', minWidth: '160px',
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Client or order…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary, minWidth: 0 }}
            />
            {search && (
              <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 0, lineHeight: 1, fontSize: '13px' }}>✕</button>
            )}
          </div>
        </div>

        {/* ── Table ── */}
        {listLoading ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            {search.trim()
              ? `No results for "${search.trim()}".`
              : EMPTY_MESSAGES[activeTab]}
          </div>
        ) : (
          <PaymentsTable
            rows={visible}
            isAdmin={isAdmin}
            userId={userId}
            cutoff={archiveCutoff()}
            highlightId={highlightId}
            onRowClick={handleRowClick}
            onView={r => setDetailRequest(r)}
            onEdit={r => setEditRequest(r)}
            onDelete={r => setDeleteRequest(r)}
          />
        )}

      </div>

      {/* ── Modals ── */}
      {showForm && (
        <NewPaymentConfirmationModal
          userId={userId}
          supabase={supabase}
          initialClientName={formPrefill?.clientName}
          initialSalesNote={formPrefill?.salesNote}
          contextLabel={formPrefill?.contextLabel}
          onClose={() => { setShowForm(false); setFormPrefill(null) }}
          onSaved={() => { setShowForm(false); setFormPrefill(null); loadRequests() }}
        />
      )}
      {reviewRequest && (
        <AdminReviewModal
          request={reviewRequest}
          supabase={supabase}
          onClose={() => setReviewRequest(null)}
          onActioned={() => { setReviewRequest(null); loadRequests() }}
        />
      )}
      {detailRequest && (
        <DetailsModal
          request={detailRequest}
          onClose={() => setDetailRequest(null)}
          isAdmin={isAdmin}
          userId={userId}
          supabase={supabase}
          onCorrected={() => { setDetailRequest(null); loadRequests() }}
          // Details hands off to the same two modals the table uses; only one
          // Finance modal is open at a time, so it closes as they open.
          onEdit={r => { setDetailRequest(null); setEditRequest(r) }}
          onDelete={r => { setDetailRequest(null); setDeleteRequest(r) }}
        />
      )}
      {editRequest && (
        <EditPaymentModal
          request={editRequest}
          isAdmin={isAdmin}
          supabase={supabase}
          onClose={() => setEditRequest(null)}
          onSaved={() => { setEditRequest(null); loadRequests() }}
        />
      )}
      {deleteRequest && (
        <DeleteConfirmModal
          request={deleteRequest}
          supabase={supabase}
          onClose={() => setDeleteRequest(null)}
          onDeleted={() => { setDeleteRequest(null); loadRequests() }}
        />
      )}

    </FinanceLayout>
  )
}
