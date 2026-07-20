'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { X, CheckCircle2 } from 'lucide-react'
import { notifyOrders } from '@/lib/notify'
import { formatINR } from '@/lib/currency'
import { RequestModalShell } from '@/app/finance/components/FinanceModalShell'

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
  converted_order_id: string | null
  converted_order_number?: string
  converted_order_total_value?: number | string | null
}

// The project's existing requester rule (order_requests_requester_select /
// _insert, and resubmit_order_request): the requester is created_by OR
// requested_by. assigned_to is deliberately NOT an owner.
function isPermittedRequester(r: OrderRequest, userId: string): boolean {
  return r.created_by === userId || r.requested_by === userId
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

// Returned by the list_eligible_order_assignees() RPC: active Sales-team
// members plus anyone explicitly authorised via the permission engine
// (orders.can_be_order_assignee), already deduplicated and grouped server-side.
type AssigneeOption = { id: string; full_name: string; source: 'sales' | 'override' }

type StatusFilter = 'active' | 'needs_clarification' | 'rejected' | 'converted' | 'all'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  submitted:           { label: 'Submitted',           bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  needs_clarification: { label: 'Needs Clarification',  bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' },
  rejected:            { label: 'Rejected',             bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
  converted:           { label: 'Converted',            bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
}

// Phase 1: "Active" means submitted (awaiting review).
const STATUS_TABS: { key: StatusFilter; label: string; match: (s: string) => boolean }[] = [
  { key: 'active',              label: 'Active',              match: s => s === 'submitted' },
  { key: 'needs_clarification', label: 'Needs Clarification', match: s => s === 'needs_clarification' },
  { key: 'rejected',            label: 'Rejected',            match: s => s === 'rejected' },
  { key: 'converted',           label: 'Converted',           match: s => s === 'converted' },
  { key: 'all',                 label: 'All',                 match: () => true },
]

const LEAD_SOURCE_OPTIONS = [
  { value: 'reference',       label: 'Reference' },
  { value: 'repeat_customer', label: 'Repeat Customer' },
  { value: 'whatsapp',        label: 'WhatsApp' },
  { value: 'instagram',       label: 'Instagram' },
  { value: 'website',         label: 'Website' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

// Maps an incoming ?tab= value (e.g. from the Admin Action Queue) to a known
// StatusFilter, defaulting to 'active' for anything missing or unrecognized —
// never throws on an invalid/stale deep link.
const STATUS_FILTER_KEYS: StatusFilter[] = ['active', 'needs_clarification', 'rejected', 'converted', 'all']
function parseStatusFilter(value: string | null): StatusFilter {
  return (STATUS_FILTER_KEYS as string[]).includes(value ?? '') ? (value as StatusFilter) : 'active'
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
// The only reliable payment linkage in the system is
// finance_payment_requests.order_id -> orders.id (enforced by the
// finance_payment_requests_status_order_invariant CHECK: approved_linked rows
// always carry an order_id, approved_unlinked rows never do). A request reaches
// that linkage only through converted_order_id, so:
//   - unconverted requests have NO trustworthy payment reference (client_name
//     matching is display-only guidance elsewhere in this file, never a
//     financial rule) and are reported as "not linked" — never a confirmed ₹0;
//   - finance_payment_requests SELECT RLS is admin-only (plus own submissions),
//     so non-admin viewers are reported as "restricted" — never a false ₹0
//     summed from a partial view (same gating as the Orders dashboard);
//   - for converted requests seen by an admin, received = SUM(amount) of
//     approved_linked payments on the converted order, and the percentage uses
//     the converted order's total_value as denominator — the exact formula the
//     Order detail page already uses, so both surfaces always agree.
type AdvanceInfo =
  | { kind: 'not_linked' }
  | { kind: 'restricted' }
  | { kind: 'known'; received: number; denominator: number | null; pct: number | null; pending: number | null }

function getAdvanceInfo(r: OrderRequest, advanceByOrder: Record<string, number> | null): AdvanceInfo {
  if (!r.converted_order_id) return { kind: 'not_linked' }
  if (advanceByOrder == null) return { kind: 'restricted' }
  const received = advanceByOrder[r.converted_order_id] ?? 0
  const rawDenom = r.converted_order_total_value
  const denomNum = rawDenom == null || rawDenom === '' ? NaN : Number(rawDenom)
  // A null or zero order value cannot anchor a percentage — report it as
  // unavailable rather than showing a false 0% (and never divide by zero).
  const denominator = Number.isFinite(denomNum) && denomNum > 0 ? denomNum : null
  const pct = denominator != null ? Math.round((received / denominator) * 100) : null
  const pending = denominator != null ? Math.max(0, denominator - received) : null
  return { kind: 'known', received, denominator, pct, pending }
}

// Compact two-line advance indicator for the table. The bar is visually capped
// at 100% but the printed percentage stays real (e.g. 105% on overpayment).
function AdvanceCell({ info }: { info: AdvanceInfo }) {
  if (info.kind === 'not_linked') {
    return <span style={{ fontSize: '12px', color: colors.muted }}>Not linked</span>
  }
  if (info.kind === 'restricted') {
    return <span style={{ color: colors.muted }}>—</span>
  }
  const { received, pct } = info
  const tone = pct == null || pct <= 0 ? colors.muted : pct >= 100 ? colors.green : colors.blue
  return (
    <div>
      <div style={{ fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
        {formatINR(received)}
      </div>
      <div style={{ fontSize: '11px', color: tone, marginTop: '2px' }}>
        {pct == null ? 'Percentage unavailable' : `${pct}% received`}
      </div>
      {pct != null && (
        <div style={{ width: '72px', height: '3px', borderRadius: '2px', background: colors.float, marginTop: '4px', overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: tone }} />
        </div>
      )}
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
function MetricGroup({ label, value, note, valueMuted, bar }: {
  label: string
  value: string
  note?: string
  valueMuted?: boolean
  bar?: { pct: number; tone: string }
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
    </div>
  )
}

function RequestDetailsModal({
  request: r,
  advance,
  isAdmin,
  currentUserId,
  onClose,
  onConvert,
  onClarify,
  onReject,
  onResubmit,
  onReapply,
  onOpenOrder,
}: {
  request: OrderRequest
  advance: AdvanceInfo
  isAdmin: boolean
  currentUserId: string
  onClose: () => void
  onConvert: () => void
  onClarify: () => void
  onReject: () => void
  onResubmit: () => void
  onReapply: () => void
  onOpenOrder: () => void
}) {
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
  const advanceTone = advance.kind === 'known' && advance.pct != null
    ? (advance.pct <= 0 ? colors.muted : advance.pct >= 100 ? colors.green : colors.blue)
    : colors.muted
  const top = (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1px', background: colors.border }}>
        <MetricGroup label="Total Order Value"   value={fmtAmount(r.total_value)}         valueMuted={r.total_value == null} />
        <MetricGroup label="Total Product Value" value={fmtAmount(r.total_product_value)} valueMuted={r.total_product_value == null} />
        {advance.kind === 'known' ? (
          <>
            <MetricGroup
              label="Advance Received"
              value={formatINR(advance.received)}
              note={advance.pending != null ? `Pending ${formatINR(advance.pending)}` : undefined}
            />
            <MetricGroup
              label="Payment Position"
              value={advance.pct != null ? `${advance.pct}%` : '—'}
              valueMuted={advance.pct == null}
              note={advance.pct != null ? 'received' : 'Percentage unavailable'}
              bar={advance.pct != null ? { pct: advance.pct, tone: advanceTone } : undefined}
            />
          </>
        ) : advance.kind === 'not_linked' ? (
          <>
            <MetricGroup label="Advance Received" value="Not linked" valueMuted note="Payments link after conversion" />
            <MetricGroup label="Payment Position" value="—" valueMuted note="Available after conversion" />
          </>
        ) : (
          <>
            <MetricGroup label="Advance Received" value="—" valueMuted note="Finance access required" />
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

      {r.status === 'converted' && r.converted_order_number && (
        <div style={{ padding: '12px 16px', borderRadius: '10px', background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
          <div style={contextLabelStyle('#166534')}>Converted</div>
          <div style={{ ...contextBodyStyle('#166534'), whiteSpace: 'normal' }}>
            Official Order {r.converted_order_number} was created from this request.
          </div>
        </div>
      )}
    </>
  )

  // ── Actions — identical visibility rules to the former table buttons ──
  const canReview    = isAdmin && r.status === 'submitted'
  const canResubmit  = r.status === 'needs_clarification' && isPermittedRequester(r, currentUserId)
  const canReapply   = r.status === 'rejected' && isPermittedRequester(r, currentUserId)
  const canOpenOrder = r.status === 'converted' && !!r.converted_order_id

  const actionBtn: React.CSSProperties = {
    padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  }
  const footer = (canReview || canResubmit || canReapply || canOpenOrder) ? (
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
      {/* Destructive action stays visually separated on the far left */}
      {canReview && (
        <button onClick={onReject} style={{ ...actionBtn, background: 'transparent', border: '1px solid #FECACA', color: '#991B1B' }}>
          Reject Request
        </button>
      )}
      <div style={{ flex: 1 }} />
      {canReview && (
        <button onClick={onClarify} style={{ ...actionBtn, background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary }}>
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
      {canOpenOrder && (
        <button onClick={onOpenOrder} style={{ ...actionBtn, background: '#DC1F2E', border: 'none', color: '#fff' }}>
          Open Order
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
      top={top}
      left={left}
      right={right}
      bottom={bottom}
      footer={footer}
      width="980px"
      ariaLabel={`Order request ${r.request_number}`}
    />
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
  const [loadingPayments, setLoadingPayments] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const supabase = useMemo(() => createClient(), [])

  // Eligible = approved but not yet attached to any Order. Admin-only data:
  // this relies on the existing finance_payment_requests admin SELECT policy,
  // so no Finance visibility is widened for anyone else. The DB order
  // (payment_date desc) is the newest-first tie-break preserved within each
  // client-match group by the stable sort in `sortedPayments` below — the
  // match/mismatch grouping itself has no column to sort by server-side,
  // since it depends on comparing against this specific request's client_name.
  const loadEligiblePayments = async () => {
    setLoadingPayments(true)
    const { data } = await supabase
      .from('finance_payment_requests')
      .select('id, request_number, client_name, amount, payment_date, proof_note, submitted_by_user:users!submitted_by(full_name)')
      .eq('status', 'approved_unlinked')
      .is('order_id', null)
      .order('payment_date', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: EligiblePayment[] = ((data ?? []) as any[]).map(p => ({
      id: p.id,
      request_number: p.request_number,
      client_name: p.client_name,
      amount: p.amount,
      payment_date: p.payment_date,
      proof_note: p.proof_note ?? null,
      submitted_by_name: p.submitted_by_user?.full_name ?? undefined,
    }))
    setPayments(mapped)
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
        setError('Could not convert this request. Please refresh and try again.')
      }
      setSaving(false)
      return
    }

    const result = data as ConvertResult

    // Notify the creator and the assigned user of the conversion. Any payments
    // linked during conversion are covered by this single notification.
    void notifyOrders({
      event: 'order_converted',
      requestNumber: request.request_number,
      entityId: request.id,
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

// ── Update and Resubmit modal (permitted requester only) ──────────────────────
// One action: edit the permitted business fields and hand the request back for
// review. No draft, no separate reply — the edit IS the response.

function ResubmitModal({
  request,
  salesAssignees,
  overrideAssignees,
  onClose,
  onResubmitted,
}: {
  request: OrderRequest
  salesAssignees: AssigneeOption[]
  overrideAssignees: AssigneeOption[]
  onClose: () => void
  onResubmitted: (requestNumber: string) => void
}) {
  // A legacy assignee that no longer qualifies (inactive, or neither Sales
  // nor authorised) stays visible and selected — never silently dropped.
  const isLegacyAssigneeOutOfList = !!request.assigned_to
    && !salesAssignees.some(u => u.id === request.assigned_to)
    && !overrideAssignees.some(u => u.id === request.assigned_to)

  const [form, setForm] = useState<RequestForm>({
    client_name:          request.client_name,
    assigned_to:          request.assigned_to ?? '',
    confirm_date:         request.confirm_date ?? '',
    due_date:             request.due_date ?? '',
    total_product_value: request.total_product_value != null ? String(request.total_product_value) : '',
    total_value:          request.total_value != null ? String(request.total_value) : '',
    lead_source:          request.lead_source ?? '',
    notes:                request.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const set = (k: keyof RequestForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

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

    const { error: rpcErr } = await supabase.rpc('resubmit_order_request', {
      p_order_request_id:    request.id,
      p_client_name:         form.client_name,
      p_assigned_to:         form.assigned_to  || null,
      p_confirm_date:        form.confirm_date || null,
      p_due_date:            form.due_date     || null,
      p_total_value:         form.total_value  ? parseFloat(form.total_value) : null,
      p_total_product_value: form.total_product_value ? parseFloat(form.total_product_value) : null,
      p_lead_source:         form.lead_source  || null,
      p_notes:               form.notes,
    })

    if (rpcErr) {
      setError(rpcErr.message?.includes('Assignee must be')
        ? rpcErr.message
        : 'Could not resubmit this request. It may have already changed. Please refresh and try again.')
      setSaving(false)
      return
    }

    // Back to the reviewers' queue — notify approvers it was resubmitted.
    void notifyOrders({
      event: 'order_resubmitted',
      requestNumber: request.request_number,
      entityId: request.id,
      clientName: form.client_name.trim(),
    })

    onResubmitted(request.request_number)
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
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Update and Resubmit</div>
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
          {/* The question being answered — shown prominently, above the fields. */}
          {request.clarification_note && (
            <div style={{
              background: '#EFF6FF', border: '1px solid #BFDBFE',
              borderRadius: '6px', padding: '10px 12px',
            }}>
              <div style={{
                fontSize: '10px', fontWeight: 700, color: '#1E40AF',
                textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
              }}>
                Clarification requested
              </div>
              <div style={{ fontSize: '13px', color: '#1E3A8A', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {request.clarification_note}
              </div>
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
              {saving ? 'Resubmitting…' : 'Update and Resubmit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Update and Reapply modal (permitted requester only) ────────────────────────
// One action: edit the permitted business fields and hand a rejected request
// back for review. Mirrors ResubmitModal exactly, but shows the rejection
// reason (not a clarification note) and calls reapply_order_request.

function ReapplyModal({
  request,
  salesAssignees,
  overrideAssignees,
  onClose,
  onReapplied,
}: {
  request: OrderRequest
  salesAssignees: AssigneeOption[]
  overrideAssignees: AssigneeOption[]
  onClose: () => void
  onReapplied: (requestNumber: string) => void
}) {
  // A legacy assignee that no longer qualifies (inactive, or neither Sales
  // nor authorised) stays visible and selected — never silently dropped.
  const isLegacyAssigneeOutOfList = !!request.assigned_to
    && !salesAssignees.some(u => u.id === request.assigned_to)
    && !overrideAssignees.some(u => u.id === request.assigned_to)

  const [form, setForm] = useState<RequestForm>({
    client_name:          request.client_name,
    assigned_to:          request.assigned_to ?? '',
    confirm_date:         request.confirm_date ?? '',
    due_date:             request.due_date ?? '',
    total_product_value: request.total_product_value != null ? String(request.total_product_value) : '',
    total_value:          request.total_value != null ? String(request.total_value) : '',
    lead_source:          request.lead_source ?? '',
    notes:                request.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const set = (k: keyof RequestForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

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

    const { error: rpcErr } = await supabase.rpc('reapply_order_request', {
      p_order_request_id:    request.id,
      p_client_name:         form.client_name,
      p_assigned_to:         form.assigned_to  || null,
      p_confirm_date:        form.confirm_date || null,
      p_due_date:            form.due_date     || null,
      p_total_value:         form.total_value  ? parseFloat(form.total_value) : null,
      p_total_product_value: form.total_product_value ? parseFloat(form.total_product_value) : null,
      p_lead_source:         form.lead_source  || null,
      p_notes:               form.notes,
    })

    if (rpcErr) {
      setError(rpcErr.message?.includes('Assignee must be')
        ? rpcErr.message
        : 'Could not reapply this request. It may have already changed. Please refresh and try again.')
      setSaving(false)
      return
    }

    // Back to the reviewers' queue after a rejection — notify approvers.
    void notifyOrders({
      event: 'order_resubmitted',
      requestNumber: request.request_number,
      entityId: request.id,
      clientName: form.client_name.trim(),
    })

    onReapplied(request.request_number)
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
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Update and Reapply</div>
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
          {/* The reason being addressed — shown prominently, above the fields,
              and kept visible for the whole edit until reapplication succeeds. */}
          {request.rejection_reason && (
            <div style={{
              background: '#FEF2F2', border: '1px solid #FECACA',
              borderRadius: '6px', padding: '10px 12px',
            }}>
              <div style={{
                fontSize: '10px', fontWeight: 700, color: '#991B1B',
                textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
              }}>
                Rejection reason
              </div>
              <div style={{ fontSize: '13px', color: '#7F1D1D', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {request.rejection_reason}
              </div>
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
              {saving ? 'Reapplying…' : 'Update and Reapply'}
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
  const [reapplyTarget,  setReapplyTarget]  = useState<OrderRequest | null>(null)
  const [detailsTarget,  setDetailsTarget]  = useState<OrderRequest | null>(null)
  const [actionMessage,  setActionMessage]  = useState<string | null>(null)
  const [highlightId,    setHighlightId]    = useState<string | null>(null)
  // Sum of approved_linked payment amounts per converted order id. null means
  // the viewer cannot read Finance data (non-admin RLS) — rendered as "—",
  // never as a false ₹0.
  const [advanceByOrder, setAdvanceByOrder] = useState<Record<string, number> | null>(null)

  const router       = useRouter()
  const searchParams = useSearchParams()

  // ?tab= from the Admin Action Queue selects the initial tab; manual tab
  // clicks below still just call setStatusTab and are otherwise untouched.
  const [statusTab, setStatusTab] = useState<StatusFilter>(() => parseStatusFilter(searchParams.get('tab')))

  // Guards the one-time ?request= deep-link resolution below so it can never
  // re-fire and reopen a modal the admin already closed.
  const deepLinkHandled = useRef(false)
  const supabase = useMemo(() => createClient(), [])

  const loadRequests = async (roleOverride?: string) => {
    setListLoading(true)
    const { data } = await supabase
      .from('order_requests')
      .select(`
        id, request_number, client_name,
        requested_by, assigned_to,
        confirm_date, due_date, total_value, total_product_value, lead_source, notes,
        status, created_by, clarification_note, rejection_reason, created_at, converted_order_id,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name),
        converted_order:orders!converted_order_id(display_number, total_value)
      `)
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: OrderRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      requested_by_name:            r.requested_by_user?.full_name ?? undefined,
      assigned_to_name:             r.assigned_to_user?.full_name  ?? undefined,
      converted_order_number:       r.converted_order?.display_number ?? undefined,
      converted_order_total_value:  r.converted_order?.total_value ?? null,
      requested_by_user: undefined,
      assigned_to_user:  undefined,
      converted_order:   undefined,
    }))
    setRequests(mapped)

    // Advance-received aggregation: one batched query for every converted
    // order on the page (no per-row N+1). Admin only — finance_payment_requests
    // SELECT RLS returns all rows only to admins; anyone else would get a
    // partial (own-submissions) view that must not be presented as a total.
    // Only approved_linked rows count: that is the exact rule the Order detail
    // page already uses, and the status<->order_id CHECK invariant guarantees
    // pending/clarification/rejected/unlinked rows carry no order_id anyway.
    const role = roleOverride ?? profile?.role
    const convertedOrderIds = mapped.filter(r => r.converted_order_id).map(r => r.converted_order_id as string)
    if (role === 'admin' && convertedOrderIds.length > 0) {
      const { data: payData } = await supabase
        .from('finance_payment_requests')
        .select('order_id, amount')
        .eq('status', 'approved_linked')
        .in('order_id', convertedOrderIds)
      const sums: Record<string, number> = {}
      for (const p of (payData ?? []) as { order_id: string | null; amount: number | string }[]) {
        const amt = Number(p.amount)
        if (p.order_id && Number.isFinite(amt)) sums[p.order_id] = (sums[p.order_id] ?? 0) + amt
      }
      setAdvanceByOrder(sums)
    } else if (role === 'admin') {
      setAdvanceByOrder({})
    } else {
      setAdvanceByOrder(null)
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

      // profile state isn't visible to this closure yet — pass the role in.
      await loadRequests((me as UserProfile | null)?.role)
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
        // correctly.
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

  const isAdmin = profile?.role === 'admin'

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

      {/* ── Search + tabs + submit button ── */}
      <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <input
            className="boe-input"
            placeholder="Search by request number or client…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth: '320px', flex: 1, minWidth: '180px' }}
          />
          <button
            onClick={() => setShowModal(true)}
            style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff', cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            + New Order Request
          </button>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {STATUS_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setStatusTab(tab.key)}
              style={{
                padding: '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                cursor: 'pointer', border: '1px solid',
                borderColor: statusTab === tab.key ? '#DC1F2E' : colors.border,
                background:   statusTab === tab.key ? 'rgba(220,31,46,0.07)' : 'transparent',
                color:        statusTab === tab.key ? '#DC1F2E' : colors.secondary,
                transition: 'all 0.1s',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
          fontSize: '12px', color: colors.muted,
        }}>
          {listLoading ? 'Loading…' : `${visible.length} request${visible.length !== 1 ? 's' : ''}`}
        </div>

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
                    onClick={() => setDetailsTarget(r)}
                    onKeyDown={e => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailsTarget(r) }
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
                        onClick={e => { e.stopPropagation(); setDetailsTarget(r) }}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          font: 'inherit', fontWeight: 600, color: colors.primary,
                          textDecoration: 'underline', textUnderlineOffset: '3px',
                          textDecorationColor: colors.borderMed,
                        }}
                      >
                        {r.request_number}
                      </button>
                      {r.status === 'converted' && r.converted_order_number && (
                        <div style={{ fontSize: '11px', fontWeight: 500, color: colors.muted, marginTop: '2px' }}>
                          → Order {r.converted_order_number}
                        </div>
                      )}
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
                      <AdvanceCell info={getAdvanceInfo(r, advanceByOrder)} />
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
          request={detailsTarget}
          advance={getAdvanceInfo(detailsTarget, advanceByOrder)}
          isAdmin={isAdmin}
          currentUserId={currentUserId}
          // While an action modal is layered above, the shell's Escape/overlay
          // close must not tear down the details view underneath it.
          onClose={() => {
            if (convertTarget || clarifyTarget || rejectTarget || resubmitTarget || reapplyTarget) return
            setDetailsTarget(null)
          }}
          onConvert={()  => setConvertTarget(detailsTarget)}
          onClarify={()  => setClarifyTarget(detailsTarget)}
          onReject={()   => setRejectTarget(detailsTarget)}
          onResubmit={() => setResubmitTarget(detailsTarget)}
          onReapply={()  => setReapplyTarget(detailsTarget)}
          onOpenOrder={() => {
            if (detailsTarget.converted_order_id) router.push(`/orders/${detailsTarget.converted_order_id}`)
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

      {resubmitTarget && (
        <ResubmitModal
          request={resubmitTarget}
          salesAssignees={salesAssignees}
          overrideAssignees={overrideAssignees}
          onClose={() => setResubmitTarget(null)}
          onResubmitted={requestNumber => {
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

      {reapplyTarget && (
        <ReapplyModal
          request={reapplyTarget}
          salesAssignees={salesAssignees}
          overrideAssignees={overrideAssignees}
          onClose={() => setReapplyTarget(null)}
          onReapplied={requestNumber => {
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
