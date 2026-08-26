'use client'

// ── Giving available money a home ─────────────────────────────────────────────
//
// The one control that spends part of a payment. It offers exactly two kinds of
// target, because those are the only two the business has:
//
//   a permitted Confirmed Order   — approved, numbered, in production
//   a permitted PI Draft          — submitted and awaiting approval
//
// AND NOT AN ORDER REQUEST. That workflow is retired (20261007000000): the RPC
// takes no such parameter, the database refuses the linkage, and offering the
// choice would be an invitation to a write that cannot land.
//
// WHAT IS SHOWN BEFORE THE DECISION, AND WHY
// ------------------------------------------
// Choosing a target is a judgement about how much money a piece of business
// still needs, and that judgement cannot be made from a name and a number. So a
// selected target loads its own position — what it is worth, what has already
// been attributed to it, and what is still outstanding — from the SAME functions
// the Order and PI screens read:
//
//   Order  order_linked_payment_total(), the canonical attribution rule in SQL
//   PI     pi_submission_payment_summary(), the PI card's own figures
//
// Neither is re-derived here. Two implementations of "how much has this Order
// received" is precisely the arrangement PR #49 removed.
//
// EVERY GATE IS THE DATABASE'S
// ----------------------------
// allocate_payment_to_target() re-derives the actor, requires finance.allocate,
// locks the payment, re-computes the unallocated balance UNDER THAT LOCK,
// re-validates that the target exists, is eligible and is visible to the caller,
// refuses a duplicate active claim, refuses a rejected payment, and writes the
// activity trail itself. Nothing below authorizes anything: the cap on the
// amount input and the search's own scoping exist so the reader is told BEFORE a
// round trip, and the modal is drawn only for a holder of finance.allocate
// because offering a control that will certainly be refused is worse than not
// offering it.
//
// THE SEARCH IS RLS-SCOPED, WHICH IS THE POINT. A salesperson searching Orders
// sees the Orders they may already see, and the same for PI Drafts, so "only
// within their permitted scope" is not a filter written here that could drift —
// it is the same policy the Orders module itself applies, asked again.

import { useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { isValidAmount } from '@/lib/currency'

export const ALLOCATE_MODAL_TITLE = 'Allocate Payment'

/** The label on the control that opens this. Named once so tests read the product's word. */
export const ALLOCATE_ACTION_LABEL = 'Allocate'

/** PI statuses that may receive an allocation, mirroring the RPC's own refusals. */
export const ALLOCATABLE_PI_STATUSES = ['draft', 'submitted', 'needs_changes'] as const

export type AllocationTargetKind = 'order' | 'submission'

export type AllocationCandidate = {
  kind: AllocationTargetKind
  id: string
  /**
   * The number for an Order; for a PI Draft, the workbook's own source number or
   * its file name — a PI has no allocated number until approval issues one, and
   * inventing one on a picker would be worse than showing what the document says.
   */
  reference: string
  clientName: string
  status: string
  /** What the piece of business is worth, when it is known. */
  value: string | number | null
}

/** What a selected target has already received, and what it still needs. */
export type TargetPosition = {
  /** Attributed under the canonical rule. Null when it could not be read. */
  received: string | null
  /** value - received, floored at zero. Null when either side is unknown. */
  outstanding: string | null
}

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  on_hold: 'On Hold',
  ready_for_dispatch: 'Ready for Dispatch',
  dispatched: 'Dispatched',
  draft: 'Draft',
  submitted: 'Submitted for Review',
  needs_changes: 'Needs Changes',
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

/**
 * The greatest amount this allocation may be.
 *
 * The payment's own available balance, and nothing more. A null balance — the
 * reader may not see every allocation, so the projection withheld it — caps at
 * NOTHING rather than at the payment amount: allocating against a balance
 * nobody can vouch for is how the same rupees get spent twice.
 */
export function allocationCeiling(availableBalance: string | number | null): number | null {
  if (availableBalance === null || availableBalance === undefined) return null
  const parsed = Number(availableBalance)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Why the Allocate button is disabled, in one sentence, or null when it is not.
 *
 * Stated as a function so the reason is testable and so the control never sits
 * greyed out with no explanation — which is the failure mode that has somebody
 * clicking it repeatedly.
 */
export function allocationBlockedReason(input: {
  ceiling: number | null
  selected: AllocationCandidate | null
  amount: string
}): string | null {
  if (input.ceiling === null) {
    return 'This payment’s available balance is not visible to you, so it cannot be allocated here.'
  }
  if (input.ceiling === 0) {
    return 'This payment has no balance left to allocate.'
  }
  if (!input.selected) return 'Choose an Order or a PI Draft.'
  if (!isValidAmount(input.amount)) return 'Enter an amount in rupees and paise.'
  if (Number(input.amount) > input.ceiling) {
    return `That is more than the ${formatMoney(input.ceiling)} still available on this payment.`
  }
  return null
}

/** Server refusals, mapped to a sentence naming the rule that refused. */
export function allocationErrorMessage(raw: string | null | undefined): string {
  const m = raw ?? ''
  if (m.includes('ALLOCATION_EXCEEDS_PAYMENT')) {
    return 'That is more than this payment has left. Refresh — somebody may have allocated part of it already.'
  }
  if (m.includes('ALLOCATION_DUPLICATE')) {
    return 'This payment is already allocated to that record. Reverse that allocation before creating another.'
  }
  if (m.includes('ALLOCATION_TARGET_CONVERTED')) {
    return 'That PI has been approved and is now an Order. Allocate to the Order instead.'
  }
  if (m.includes('ALLOCATION_TARGET_NOT_ACTIVE')) {
    return 'That record can no longer receive money. Refresh and choose another.'
  }
  if (m.includes('ALLOCATION_TARGET_CLAIMED')) {
    return 'That PI is reserved for deletion and cannot receive an allocation.'
  }
  if (m.includes('ALLOCATION_TARGET_NOT_AVAILABLE')) {
    return 'That record is not available to you. Refresh and choose another.'
  }
  if (m.includes('ALLOCATION_TARGET_REQUIRED')) {
    return 'Choose exactly one Order or PI Draft.'
  }
  if (m.includes('ALLOCATION_AMOUNT_INVALID')) {
    return 'Enter a positive amount in rupees and paise.'
  }
  if (m.includes('PAYMENT_REJECTED')) {
    return 'This payment was rejected and cannot be allocated. Reapply it first.'
  }
  if (m.includes('PAYMENT_NOT_FOUND')) {
    return 'This payment no longer exists. Refresh the list.'
  }
  if (m.includes('permission')) {
    return 'You do not have permission to allocate payments.'
  }
  return 'The allocation could not be recorded. Refresh and try again.'
}

/**
 * ONE SEARCH, TWO SOURCES, THREE MATCHABLE THINGS.
 *
 * Order number, PI reference and client name — the three ways somebody actually
 * identifies a piece of business. Both reads are RLS-scoped, so what comes back
 * is what this reader may already open; no scope is written here.
 *
 * EXPORTED because the Add Payment form divides a payment across several of
 * these at once and must offer exactly the same candidates under exactly the
 * same scoping. Two pickers would be two answers to "what may I allocate to",
 * which is the arrangement this whole area has been removing.
 *
 * `kind` NARROWS THE SOURCES, IT DOES NOT NARROW THE RULES. A form that has
 * already asked "PI Draft or Confirmed Order?" knows the answer, and reading
 * the other table would be a query whose every row is discarded. The filters,
 * the limits and the RLS scoping on the table that IS read are unchanged.
 */
export async function searchAllocationTargets(
  supabase: ReturnType<typeof createClient>,
  term: string,
  kind?: AllocationTargetKind | null,
): Promise<AllocationCandidate[]> {
  const wantOrders = kind !== 'submission'
  const wantDrafts = kind !== 'order'

  const [ordersRes, draftsRes] = await Promise.all([
    !wantOrders ? Promise.resolve({ data: [] }) : supabase
      .from('orders')
      .select('id, display_number, client_name, total_value, status')
      .or(`display_number.ilike.%${term}%,client_name.ilike.%${term}%`)
      // The RPC refuses a cancelled Order outright, so it is not offered.
      .not('status', 'in', '(cancelled)')
      .order('created_at', { ascending: false })
      .limit(15),
    // A PI HAS NO ALLOCATED NUMBER of its own until one is reserved or issued.
    // So its "reference" is what the workbook itself carries: the source order
    // number typed into the document, and the file name the employee uploaded.
    // Both are searchable because a salesperson identifies a draft by whichever
    // of the two they have.
    !wantDrafts ? Promise.resolve({ data: [] }) : supabase
      .from('order_submissions')
      .select('id, source_order_number, source_workbook_name, client_name, grand_total, status')
      .or(`source_order_number.ilike.%${term}%,source_workbook_name.ilike.%${term}%,client_name.ilike.%${term}%`)
      // An approved PI has become an Order and its money belongs to the Order;
      // a rejected one receives nothing. The RPC refuses both, and this agrees
      // with it rather than offering a choice that would fail.
      .in('status', ALLOCATABLE_PI_STATUSES as unknown as string[])
      .order('created_at', { ascending: false })
      .limit(15),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orders: AllocationCandidate[] = ((ordersRes.data ?? []) as any[]).map(o => ({
    kind: 'order',
    id: o.id,
    reference: o.display_number ?? '—',
    clientName: o.client_name ?? '—',
    status: o.status,
    value: o.total_value,
  }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drafts: AllocationCandidate[] = ((draftsRes.data ?? []) as any[]).map(d => ({
    kind: 'submission',
    id: d.id,
    reference: d.source_order_number || d.source_workbook_name || 'PI Draft',
    clientName: d.client_name ?? '—',
    status: d.status,
    value: d.grand_total,
  }))

  return [...orders, ...drafts]
}

/**
 * What a chosen target has already received, and what it still needs.
 *
 * FROM THE SAME FUNCTIONS THE TARGET'S OWN SCREEN READS. A refusal resolves to
 * an unknown position rather than to zero: telling somebody an Order has
 * received nothing when they merely cannot see its payments would have them
 * allocate against a gap that is already closed.
 */
export async function loadTargetPosition(
  supabase: ReturnType<typeof createClient>,
  candidate: AllocationCandidate,
): Promise<TargetPosition> {
  if (candidate.kind === 'order') {
    const { data, error } = await supabase.rpc(
      'order_linked_payment_total', { p_order_id: candidate.id })
    const received = error ? null : (data === null || data === undefined ? null : String(data))
    return { received, outstanding: remaining(candidate.value, received) }
  }

  const { data, error } = await supabase.rpc(
    'pi_submission_payment_summary', { p_submission_id: candidate.id })
  if (error || !data) return { received: null, outstanding: null }
  const summary = data as { verified_amount?: string | number }
  const received = summary.verified_amount === undefined ? null : String(summary.verified_amount)
  return { received, outstanding: remaining(candidate.value, received) }
}

// ── The modal ─────────────────────────────────────────────────────────────────

export function AllocatePaymentModal({
  payment,
  supabase,
  onClose,
  onAllocated,
}: {
  payment: {
    id: string
    request_number: string
    client_name: string
    amount: number
    available_balance: string | number | null
  }
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onAllocated: () => void
}) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<AllocationCandidate[]>([])
  const [selected, setSelected] = useState<AllocationCandidate | null>(null)
  const [position, setPosition] = useState<TargetPosition | null>(null)
  const [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only the newest search may write results: a slow earlier query must never
  // overwrite a later one with stale rows.
  const searchToken = useRef(0)

  const ceiling = allocationCeiling(payment.available_balance)

  const runSearch = async (raw: string) => {
    setQuery(raw)
    setSelected(null)
    setPosition(null)
    const term = raw.trim()
    if (!term) { setResults([]); return }

    const token = ++searchToken.current
    setSearching(true)
    const found = await searchAllocationTargets(supabase, term)
    if (token !== searchToken.current) return
    setResults(found)
    setSearching(false)
  }

  const selectTarget = async (candidate: AllocationCandidate) => {
    setSelected(candidate)
    setPosition(null)
    setError(null)
    setPosition(await loadTargetPosition(supabase, candidate))
  }

  const blocked = allocationBlockedReason({ ceiling, selected, amount })

  const handleAllocate = async () => {
    if (blocked || !selected) return
    setSaving(true)
    setError(null)

    const { error: rpcError } = await supabase.rpc('allocate_payment_to_target', {
      p_payment_request_id: payment.id,
      p_order_submission_id: selected.kind === 'submission' ? selected.id : null,
      p_order_id: selected.kind === 'order' ? selected.id : null,
      p_allocated_amount: Number(amount),
    })

    setSaving(false)
    if (rpcError) { setError(allocationErrorMessage(rpcError.message)); return }
    onAllocated()
  }

  return (
    <FinanceModal title={ALLOCATE_MODAL_TITLE} onClose={onClose}>
      {/* What is being spent. The available balance leads, because it is the
          figure the whole decision is bounded by. */}
      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '12px 14px',
        border: `1px solid ${colors.border}`,
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px',
      }}>
        <Figure label="Available" value={ceiling === null ? 'Not visible to you' : formatMoney(ceiling)} strong />
        <Figure label="Payment" value={formatMoney(payment.amount)} />
        <Figure label="Client" value={payment.client_name} />
      </div>

      <label style={LABEL}>
        Find an Order or PI Draft
      </label>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        background: colors.raised, border: `1px solid ${colors.border}`,
        borderRadius: '6px', padding: '6px 10px',
      }}>
        <input
          type="text"
          autoFocus
          value={query}
          onChange={e => runSearch(e.target.value)}
          placeholder="Order number, PI reference or client name…"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '13px', color: colors.primary }}
        />
        {searching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
      </div>

      {results.length > 0 && !selected && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden',
          maxHeight: '220px', overflowY: 'auto',
        }}>
          {results.map((candidate, index) => (
            <button
              key={`${candidate.kind}-${candidate.id}`}
              type="button"
              onClick={() => selectTarget(candidate)}
              style={{
                display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
                gap: '12px', padding: '10px 14px', textAlign: 'left', cursor: 'pointer',
                background: 'transparent', border: 'none',
                borderBottom: index < results.length - 1 ? `1px solid ${colors.border}` : 'none',
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <KindBadge kind={candidate.kind} />
                  <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                    {candidate.reference}
                  </span>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted }}>
                    {statusLabel(candidate.status)}
                  </span>
                </span>
                <span style={{
                  display: 'block', fontSize: '12px', color: colors.secondary, marginTop: '2px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {candidate.clientName}
                </span>
              </span>
              <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, flexShrink: 0 }}>
                {candidate.value != null ? formatMoney(candidate.value) : '—'}
              </span>
            </button>
          ))}
        </div>
      )}

      {query.trim() !== '' && !searching && results.length === 0 && !selected && (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '6px 0', lineHeight: 1.5 }}>
          Nothing you can allocate to matches &ldquo;{query.trim()}&rdquo;. Only Orders and PI
          Drafts you may open are offered.
        </div>
      )}

      {/* THE POSITION OF THE CHOSEN TARGET — what it is worth, what it has
          already received under the canonical rule, and what is still
          outstanding. "Not visible to you" rather than a zero, because an
          unreadable figure and an empty one are different facts. */}
      {selected && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <KindBadge kind={selected.kind} />
            <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{selected.reference}</span>
            <span style={{ fontSize: '12px', color: colors.secondary }}>{selected.clientName}</span>
            <button
              type="button"
              onClick={() => { setSelected(null); setPosition(null) }}
              className="boe-btn boe-btn-ghost"
              style={{ marginLeft: 'auto', padding: '3px 9px', fontSize: '11px' }}
            >
              Change
            </button>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '10px',
          }}>
            <Figure label="Value" value={selected.value != null ? formatMoney(selected.value) : '—'} />
            <Figure
              label="Already received"
              value={position === null ? '…' : position.received === null ? 'Not visible to you' : formatMoney(position.received)}
            />
            <Figure
              label="Still outstanding"
              value={position === null ? '…' : position.outstanding === null ? '—' : formatMoney(position.outstanding)}
              strong
            />
          </div>
        </div>
      )}

      <label style={LABEL} htmlFor="allocate-amount">
        Amount to allocate
      </label>
      <input
        id="allocate-amount"
        className="boe-input"
        inputMode="decimal"
        value={amount}
        disabled={ceiling === null || ceiling === 0}
        onChange={e => { setAmount(e.target.value); setError(null) }}
        placeholder={ceiling && ceiling > 0 ? `Up to ${formatMoney(ceiling)}` : '—'}
        style={{ width: '100%' }}
      />

      {/* The reason the control is disabled, always stated. A greyed-out button
          with no explanation is what has somebody clicking it repeatedly. */}
      {blocked && !error && (
        <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>{blocked}</div>
      )}

      {error && (
        <div style={{
          fontSize: '12px', color: colors.red, background: colors.redTint,
          border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '8px 12px', lineHeight: 1.5,
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          Cancel
        </button>
        <button
          onClick={handleAllocate}
          disabled={blocked !== null || saving}
          className="boe-btn boe-btn-primary"
          style={{
            padding: '8px 18px', fontSize: '13px',
            opacity: (blocked !== null || saving) ? 0.6 : 1,
            cursor: (blocked !== null || saving) ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Allocating…' : ALLOCATE_ACTION_LABEL}
        </button>
      </div>
    </FinanceModal>
  )
}

// ── Small pieces ──────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{
        fontSize: strong ? '15px' : '13px',
        fontWeight: strong ? 700 : 600,
        color: colors.primary,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {value}
      </div>
    </div>
  )
}

export function KindBadge({ kind }: { kind: AllocationTargetKind }) {
  const isOrder = kind === 'order'
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: '4px',
      background: isOrder ? colors.blueTint : '#F5F3FF',
      color: isOrder ? colors.blue : '#5B21B6',
      border: `1px solid ${isOrder ? 'rgba(85,133,232,0.25)' : '#DDD6FE'}`,
      fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
    }}>
      {isOrder ? 'Confirmed Order' : 'PI Draft'}
    </span>
  )
}

/**
 * value - received, floored at zero.
 *
 * Null when either side is unknown, and never a guess: an outstanding figure
 * computed from a received total nobody could read would be a number with no
 * meaning printed where a decision is made.
 */
function remaining(value: string | number | null, received: string | null): string | null {
  if (value === null || value === undefined || received === null) return null
  const total = Number(value)
  const paid = Number(received)
  if (!Number.isFinite(total) || !Number.isFinite(paid)) return null
  return String(Math.max(0, Math.round((total - paid) * 100) / 100))
}
