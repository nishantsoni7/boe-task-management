// ── Correcting an allocation that points at the wrong record ─────────────────
//
// A payment's allocations say which PI Drafts and Orders its money belongs to.
// When one of them is wrong — the advance was put against Order 524 and the
// customer meant Order 529 — the correction is TWO acts, and this file is the
// first of them:
//
//   1. REVERSE the wrong allocation. The whole allocation, never part of it:
//      reverse_payment_allocation() (20260918000000 §12B) ends an allocation
//      and keeps the row, with who reversed it, when, and why. Its amount goes
//      back to the payment's unallocated balance, because that balance is
//      DERIVED — payment amount minus active allocations — and never stored.
//   2. ALLOCATE the released money again through Allocate Funds, which already
//      exists. There is no second allocation workflow here.
//
// Nothing is deleted, nothing is copied, and the payment row itself is not
// touched: its amount, date, mode, proof and verification status are exactly
// what they were.
//
// NOTHING HERE AUTHORIZES ANYTHING. reverse_payment_allocation() is SECURITY
// DEFINER and re-derives the actor, requires finance.allocate_correct through
// actor_has_module_permission(), refuses a blank reason, and locks the payment
// before the allocation. The checks in this file exist so a person is told
// before a round trip — never so the server can trust the browser.
//
// STALE SCREENS. Another person may reverse the same allocation, or a PI may be
// approved and its allocation moved onto the new Order, while this screen is
// open. So the allocation is read again immediately before the reversal is sent,
// and the reversal is refused HERE when the row no longer matches what the
// person was shown. The RPC's own idempotency covers the last few milliseconds:
// a reversal of an already-reversed allocation writes nothing and says so.

import type { createClient } from '@/lib/supabase/client'
import {
  ZERO,
  addExact,
  compareExact,
  exactToString,
  parseExact,
  subtractExact,
} from './exactMoney'
import { customerTargetLabel } from './mixedCustomers'

export const CORRECT_ALLOCATION_ACTION_LABEL = 'Correct Allocation'
export const CORRECT_ALLOCATION_MODAL_TITLE = 'Correct Allocation'
export const REVERSE_ALLOCATION_BUTTON_LABEL = 'Reverse allocation'

/** Long enough for a real explanation; short enough to stay one audit line. */
export const CORRECTION_REASON_MAX = 500

// ── The ledger, as this screen shows it ──────────────────────────────────────

export type AllocationLedgerEntry = {
  allocationId: string
  kind: 'order' | 'submission'
  targetId: string
  /** The Order number or the PI reference, when this reader may read the target. */
  reference: string | null
  /** The target's customer, when this reader may read the target. */
  clientName: string | null
  /** Exact, as a decimal string. */
  amount: string
  status: 'active' | 'reversed'
  allocatedAt: string | null
  reversedAt: string | null
  reversedByName: string | null
  reversalReason: string | null
}

/** One allocation row as the ledger read returns it. */
export type LedgerAllocationRow = {
  id: string
  allocated_amount: string | number | null
  status: string
  order_id: string | null
  order_submission_id: string | null
  created_at?: string | null
  reversed_at?: string | null
  reversal_reason?: string | null
  reverser?: { full_name: string | null } | { full_name: string | null }[] | null
}

export type LedgerTargetRow = {
  id: string
  reference: string | null
  clientName: string | null
}

/**
 * The payment's allocations, active first and then reversed, each named where
 * the reader may name its target.
 *
 * A row pointing at neither target is skipped: finance_payment_allocations_one_target
 * makes that impossible, and a line pointing nowhere would be worse than none.
 */
export function buildAllocationLedger(
  rows: readonly LedgerAllocationRow[],
  targets: readonly LedgerTargetRow[],
): AllocationLedgerEntry[] {
  const byId = new Map(targets.map(t => [t.id, t]))
  const entries: AllocationLedgerEntry[] = []

  for (const row of rows) {
    const targetId = row.order_id ?? row.order_submission_id
    if (!targetId) continue
    const target = byId.get(targetId)
    const share = parseExact(row.allocated_amount)
    const reverser = Array.isArray(row.reverser) ? row.reverser[0] : row.reverser
    entries.push({
      allocationId: row.id,
      kind: row.order_id ? 'order' : 'submission',
      targetId,
      reference: target?.reference ?? null,
      clientName: target?.clientName ?? null,
      amount: share ? exactToString(share) : String(row.allocated_amount ?? '0'),
      status: row.status === 'reversed' ? 'reversed' : 'active',
      allocatedAt: row.created_at ?? null,
      reversedAt: row.reversed_at ?? null,
      reversedByName: reverser?.full_name ?? null,
      reversalReason: row.reversal_reason ?? null,
    })
  }

  const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0)
  return entries.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1
    // Active in the order they were made; reversed newest first, since the
    // latest correction is the one somebody has come here to check.
    return a.status === 'active'
      ? time(a.allocatedAt) - time(b.allocatedAt)
      : time(b.reversedAt) - time(a.reversedAt)
  })
}

/** How one ledger target is written: "Order 0524" or "PI Draft 019". */
export function ledgerTargetName(entry: Pick<AllocationLedgerEntry, 'kind' | 'reference'>): string {
  // Never a uuid: a target the reader may not open is named by its kind.
  return customerTargetLabel(entry.kind, entry.reference)
}

// ── The payment's position, before and after ────────────────────────────────

export type CorrectionPosition = {
  /** Sum of ACTIVE allocations, exact. */
  allocated: string
  /** Payment amount − allocated. Not floored: a negative figure is a defect to show. */
  unallocated: string
  activeCount: number
}

export function correctionPosition(
  paymentAmount: string | number,
  entries: readonly AllocationLedgerEntry[],
): CorrectionPosition {
  let allocated = ZERO
  let activeCount = 0
  for (const e of entries) {
    if (e.status !== 'active') continue
    const share = parseExact(e.amount)
    if (share) allocated = addExact(allocated, share)
    activeCount += 1
  }
  const amount = parseExact(paymentAmount) ?? ZERO
  return {
    allocated: exactToString(allocated),
    unallocated: exactToString(subtractExact(amount, allocated)),
    activeCount,
  }
}

/**
 * The unallocated balance once `allocationId` is reversed.
 *
 * The WHOLE allocation returns — that is what a reversal is. A screen that let
 * somebody type "move ₹20,000 of it" would be describing an act the database
 * does not perform.
 */
export function unallocatedAfterReversal(
  paymentAmount: string | number,
  entries: readonly AllocationLedgerEntry[],
  allocationId: string,
): string {
  return correctionPosition(
    paymentAmount,
    entries.filter(e => e.allocationId !== allocationId),
  ).unallocated
}

// ── What stops the person before they send ───────────────────────────────────

export function correctionBlockedReason(input: {
  selected: AllocationLedgerEntry | null
  reason: string
}): string | null {
  if (!input.selected) return 'Choose the allocation that is wrong.'
  if (input.selected.status !== 'active') {
    return 'That allocation has already been reversed. Choose an active one.'
  }
  const reason = input.reason.trim()
  if (!reason) return 'Write the reason for this correction. It is kept with the payment’s history.'
  if (reason.length > CORRECTION_REASON_MAX) {
    return `Keep the reason under ${CORRECTION_REASON_MAX} characters.`
  }
  return null
}

// ── Has somebody else changed it? ────────────────────────────────────────────

/** The allocation row as it stands right now, read immediately before sending. */
export type FreshAllocationRow = {
  id: string
  status: string
  order_id: string | null
  order_submission_id: string | null
  allocated_amount: string | number | null
}

/**
 * Null when the allocation is still exactly what the person was shown;
 * otherwise a sentence saying what changed and that nothing was reversed.
 */
export function staleAllocationReason(
  shown: AllocationLedgerEntry,
  fresh: FreshAllocationRow | null,
): string | null {
  if (!fresh) {
    return 'This allocation can no longer be found. Nothing was changed. The payment has been refreshed — check it again.'
  }
  if (fresh.status !== 'active') {
    return 'Someone else has already reversed this allocation. Nothing was changed by you. The payment has been refreshed.'
  }
  const freshTarget = fresh.order_id ?? fresh.order_submission_id
  const freshKind = fresh.order_id ? 'order' : 'submission'
  if (freshTarget !== shown.targetId || freshKind !== shown.kind) {
    // The common real case: the PI was approved while this screen was open, and
    // its allocation moved onto the new Order. Reversing it now would reverse
    // money on a record the person was not looking at.
    return 'This allocation now points at a different record — most likely its PI Draft was approved and became an Order. Nothing was changed. The payment has been refreshed; check the allocation again.'
  }
  const freshAmount = parseExact(fresh.allocated_amount)
  const shownAmount = parseExact(shown.amount)
  if (!freshAmount || !shownAmount || compareExact(freshAmount, shownAmount) !== 0) {
    return 'The amount on this allocation is not what was shown. Nothing was changed. The payment has been refreshed.'
  }
  return null
}

// ── The server's refusals, in words ─────────────────────────────────────────

/**
 * Every refusal says what happened AND that nothing changed. The RPC is one
 * transaction, so a refusal really does leave everything as it was.
 */
export function reversalErrorMessage(raw: string | null | undefined, code?: string | null): string {
  const m = raw ?? ''
  if (code === '42501' || m.includes('permission to correct payment allocations')) {
    return 'You do not have permission to correct payment allocations. Nothing was changed. Ask an administrator for the Finance permission “Correct Payment Allocations”.'
  }
  if (code === '28000' || m.includes('Authentication required')) {
    return 'Your session has ended. Sign in again. Nothing was changed.'
  }
  if (m.includes('ALLOCATION_REASON_REQUIRED')) {
    return 'A reason is required to reverse an allocation. Nothing was changed.'
  }
  if (m.includes('ALLOCATION_NOT_FOUND')) {
    return 'This allocation can no longer be found. Nothing was changed. The payment has been refreshed.'
  }
  return 'The allocation could not be reversed. Nothing was changed — refresh and try again.'
}

// ── Sending it ──────────────────────────────────────────────────────────────

export type ReversalOutcome =
  /** Reversed by this call. Figures are the server's. */
  | { kind: 'reversed'; unallocatedBalance: string | null; reversedAt: string | null }
  /** Somebody else got there first; this call wrote nothing. */
  | { kind: 'already_reversed'; message: string }
  /** The screen was out of date; nothing was sent. */
  | { kind: 'stale'; message: string }
  /** Refused by the server, or unreachable. Nothing changed. */
  | { kind: 'refused'; message: string }

type Client = Pick<ReturnType<typeof createClient>, 'from' | 'rpc'>

/**
 * Re-read the allocation, then reverse it through the one authorized path.
 *
 * Returns an outcome rather than throwing, so the screen can say exactly which
 * of the four happened. Success is reported ONLY from the server's answer.
 */
export async function performAllocationReversal(
  client: Client,
  input: { allocation: AllocationLedgerEntry; reason: string },
): Promise<ReversalOutcome> {
  const reason = input.reason.trim()
  const blocked = correctionBlockedReason({ selected: input.allocation, reason })
  if (blocked) return { kind: 'refused', message: `${blocked} Nothing was changed.` }

  const { data: fresh, error: readError } = await client
    .from('finance_payment_allocations')
    .select('id, status, order_id, order_submission_id, allocated_amount')
    .eq('id', input.allocation.allocationId)
    .maybeSingle()

  if (readError) {
    return { kind: 'refused', message: 'The allocation could not be checked before reversing it. Nothing was changed — refresh and try again.' }
  }

  const stale = staleAllocationReason(input.allocation, (fresh ?? null) as FreshAllocationRow | null)
  if (stale) return { kind: 'stale', message: stale }

  const { data, error } = await client.rpc('reverse_payment_allocation', {
    p_allocation_id: input.allocation.allocationId,
    p_reason: reason,
  })

  if (error) {
    return { kind: 'refused', message: reversalErrorMessage(error.message, (error as { code?: string }).code) }
  }

  const result = (data ?? {}) as {
    already_reversed?: boolean
    unallocated_balance?: string | number | null
    reversed_at?: string | null
  }

  if (result.already_reversed) {
    return {
      kind: 'already_reversed',
      message: 'Someone else reversed this allocation moments ago. Nothing was changed by you. The payment has been refreshed.',
    }
  }

  const balance = parseExact(result.unallocated_balance)
  return {
    kind: 'reversed',
    unallocatedBalance: balance ? exactToString(balance) : null,
    reversedAt: result.reversed_at ?? null,
  }
}

// ── Reading the ledger ───────────────────────────────────────────────────────

const LEDGER_COLUMNS =
  'id, allocated_amount, status, order_id, order_submission_id, created_at, reversed_at, reversal_reason'

/**
 * Every allocation this payment has ever had — active and reversed — under the
 * reader's own RLS, with each target's number and customer where readable.
 *
 * Three bounded reads keyed on one payment. The reverser's name is asked for
 * through the users embed the Finance activity trail already uses; if that
 * embed is refused the ledger is read again without it, because a missing name
 * must never hide the allocations themselves.
 */
export async function loadAllocationLedger(
  client: Client,
  paymentId: string,
): Promise<{ entries: AllocationLedgerEntry[]; readable: boolean }> {
  let rows: LedgerAllocationRow[] | null = null

  const withNames = await client
    .from('finance_payment_allocations')
    .select(`${LEDGER_COLUMNS}, reverser:users!finance_payment_allocations_reversed_by_fkey(full_name)`)
    .eq('payment_request_id', paymentId)
  if (!withNames.error) {
    rows = (withNames.data ?? []) as unknown as LedgerAllocationRow[]
  } else {
    const plain = await client
      .from('finance_payment_allocations')
      .select(LEDGER_COLUMNS)
      .eq('payment_request_id', paymentId)
    if (plain.error) return { entries: [], readable: false }
    rows = (plain.data ?? []) as unknown as LedgerAllocationRow[]
  }

  const orderIds = [...new Set(rows.map(r => r.order_id).filter((x): x is string => Boolean(x)))]
  const submissionIds = [...new Set(rows.map(r => r.order_submission_id).filter((x): x is string => Boolean(x)))]

  const [ordersRes, submissionsRes] = await Promise.all([
    orderIds.length > 0
      ? client.from('orders').select('id, display_number, client_name').in('id', orderIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    submissionIds.length > 0
      ? client.from('order_submissions')
          .select('id, source_order_number, source_workbook_name, client_name')
          .in('id', submissionIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ])

  const targets: LedgerTargetRow[] = []
  for (const o of (ordersRes.data ?? []) as { id: string; display_number: string | null; client_name: string | null }[]) {
    targets.push({ id: o.id, reference: o.display_number ?? null, clientName: o.client_name ?? null })
  }
  for (const s of (submissionsRes.data ?? []) as {
    id: string; source_order_number: string | null; source_workbook_name: string | null; client_name: string | null
  }[]) {
    // The same naming the Received Payments list uses for a PI Draft.
    targets.push({
      id: s.id,
      reference: s.source_order_number || s.source_workbook_name || 'Draft',
      clientName: s.client_name ?? null,
    })
  }

  return { entries: buildAllocationLedger(rows, targets), readable: true }
}
