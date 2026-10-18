'use client'

// NOTE: the Allocate Payment modal that used to live in this file was never mounted
// (Allocate Funds replaced it) and has been removed. What remains is the shared
// target search, position read, badge and error mapping that Allocate Funds, Record
// Payment and the Payment Request form use. The prose below still describes the rules
// those helpers serve.

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

import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'

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
    // FINANCE READS ORDERS THROUGH finance_order_search(), NOT THE TABLE (20270221000000).
    // The table follows an Order visibility scope; this function asks the rule as it was before
    // scopes existed, so a candidate who holds both a scope and finance.allocate is offered exactly
    // the Orders — and values — they were offered before. It also leaves out cancelled Orders,
    // which the allocation RPC refuses outright, and returns fifteen at most.
    !wantOrders ? Promise.resolve({ data: [] }) : supabase.rpc('finance_order_search', { p_term: term }),
    // A PI DRAFT IS NAMED BY ITS OWN REFERENCE, PID-00001 (20270114000000):
    // the name Sales and Admin see on the draft, and the one Finance is told.
    // The workbook's own B20 number stays SEARCHABLE — a salesperson may quote
    // it — but it is never shown as the draft's name: it is normally an older
    // PI's number, and the draft page says it is not an Order number
    // (allocatedAgainst.ts keeps the same rule).
    !wantDrafts ? Promise.resolve({ data: [] }) : supabase
      .from('order_submissions')
      .select('id, draft_reference, source_order_number, source_workbook_name, client_name, grand_total, status')
      .or(`draft_reference.ilike.%${term}%,source_order_number.ilike.%${term}%,source_workbook_name.ilike.%${term}%,client_name.ilike.%${term}%`)
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
    reference: d.draft_reference || d.source_workbook_name || 'PI Draft',
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


export function KindBadge({ kind }: { kind: AllocationTargetKind }) {
  const isOrder = kind === 'order'
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: '6px',
      background: isOrder ? colors.brandTint : '#EAF0F8',
      color: isOrder ? colors.brand : '#335A86',
      border: `1px solid ${isOrder ? 'rgba(51,90,134,0.25)' : '#C3D3E6'}`,
      fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap',
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
