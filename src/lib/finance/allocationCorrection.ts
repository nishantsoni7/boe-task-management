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
// THE LEDGER IS READ WHOLE, OR NOT AT ALL. Every figure on the correction
// screen — allocated, unallocated, the active list, the reversed history, the
// customers — comes from payment_allocation_ledger_for_correction()
// (20261215000000), which returns EVERY allocation of one payment to an
// authorized corrector who may read that payment. It is NOT read from
// finance_payment_allocations directly: that table's participant policies are
// per row, so a corrector who reads the payment through one PI or Order would
// get part of the ledger and a wrong balance. If the complete read fails, the
// screen shows no figures and offers no correction. There is no fallback.
//
// STALE SCREENS. Another person may reverse the same allocation, or a PI may be
// approved and its allocation moved onto the new Order, while this screen is
// open. So the complete ledger is read again immediately before the reversal is
// sent, and the reversal is refused HERE when the allocation no longer matches
// what the person was shown. The RPC's own idempotency covers the last few
// milliseconds: a reversal of an already-reversed allocation writes nothing.

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
  /** The Order number or the PI reference, from the complete ledger read. */
  reference: string | null
  /** The target's customer, from the complete ledger read. */
  clientName: string | null
  /** Exact, as a decimal string. */
  amount: string
  status: 'active' | 'reversed'
  allocatedAt: string | null
  reversedAt: string | null
  reversedByName: string | null
  reversalReason: string | null
}

/** The RPC that returns a payment's complete ledger (20261215000000). */
export const ALLOCATION_LEDGER_RPC = 'payment_allocation_ledger_for_correction'

/** One row of payment_allocation_ledger_for_correction(), exactly as returned. */
export type LedgerRpcRow = {
  allocation_id: string
  status: string
  allocated_amount: string | number | null
  order_id: string | null
  order_submission_id: string | null
  target_reference: string | null
  client_name: string | null
  created_at: string | null
  reversed_at: string | null
  reversal_reason: string | null
  reversed_by_name: string | null
}

/**
 * The payment's allocations, active first and then reversed.
 *
 * A row pointing at neither target is skipped: finance_payment_allocations_one_target
 * makes that impossible, and a line pointing nowhere would be worse than none.
 */
export function buildAllocationLedger(rows: readonly LedgerRpcRow[]): AllocationLedgerEntry[] {
  const entries: AllocationLedgerEntry[] = []

  for (const row of rows) {
    const targetId = row.order_id ?? row.order_submission_id
    if (!targetId) continue
    const share = parseExact(row.allocated_amount)
    entries.push({
      allocationId: row.allocation_id,
      kind: row.order_id ? 'order' : 'submission',
      targetId,
      reference: row.target_reference ?? null,
      clientName: row.client_name ?? null,
      amount: share ? exactToString(share) : String(row.allocated_amount ?? '0'),
      status: row.status === 'reversed' ? 'reversed' : 'active',
      allocatedAt: row.created_at ?? null,
      reversedAt: row.reversed_at ?? null,
      reversedByName: row.reversed_by_name ?? null,
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

/**
 * Null when the allocation is still exactly what the person was shown;
 * otherwise a sentence saying what changed and that nothing was reversed.
 *
 * `fresh` is the same allocation in a COMPLETE ledger read taken just now, or
 * null when that read no longer contains it.
 */
export function staleAllocationReason(
  shown: AllocationLedgerEntry,
  fresh: AllocationLedgerEntry | null,
): string | null {
  if (!fresh) {
    return 'This allocation can no longer be found. Nothing was changed. The payment has been refreshed — check it again.'
  }
  if (fresh.status !== 'active') {
    return 'Someone else has already reversed this allocation. Nothing was changed by you. The payment has been refreshed.'
  }
  if (fresh.targetId !== shown.targetId || fresh.kind !== shown.kind) {
    // The common real case: the PI was approved while this screen was open, and
    // its allocation moved onto the new Order. Reversing it now would reverse
    // money on a record the person was not looking at.
    return 'This allocation now points at a different record — most likely its PI Draft was approved and became an Order. Nothing was changed. The payment has been refreshed; check the allocation again.'
  }
  const freshAmount = parseExact(fresh.amount)
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

// ── Reading the complete ledger ─────────────────────────────────────────────

export type LedgerRead =
  | { readable: true; entries: AllocationLedgerEntry[] }
  | { readable: false; entries: []; message: string }

/**
 * Why the complete ledger could not be read, in words that say nothing changed.
 * Keyed on the RPC's own codes (20261215000000).
 */
export function ledgerReadErrorMessage(raw: string | null | undefined, code?: string | null): string {
  const m = raw ?? ''
  if (code === '28000' || m.includes('ALLOCATION_LEDGER_AUTH_REQUIRED')) {
    return 'Your session has ended. Sign in again. Nothing was changed.'
  }
  if (code === '42501' || m.includes('ALLOCATION_LEDGER_NOT_PERMITTED')) {
    return 'You do not have permission to correct payment allocations, so the full allocation list cannot be shown. Nothing was changed.'
  }
  if (code === 'P0002' || m.includes('ALLOCATION_LEDGER_PAYMENT_NOT_FOUND')) {
    return 'This payment is not available to you, so its allocations cannot be shown. Nothing was changed.'
  }
  return 'The full allocation list for this payment could not be loaded, so no figures are shown and nothing can be corrected. Nothing was changed — close this and try again.'
}

/**
 * Every allocation this payment has ever had — active and reversed — through
 * the one authorized read. The RPC decides who may have it (authenticated,
 * Finance entry, finance.allocate_correct, and able to read the payment).
 *
 * NOTHING IS ASSEMBLED FROM A DIRECT TABLE READ. A refusal or a failure comes
 * back as unreadable, with a sentence; the caller shows no figures.
 */
export async function loadAllocationLedger(client: Client, paymentId: string): Promise<LedgerRead> {
  const { data, error } = await client.rpc(ALLOCATION_LEDGER_RPC, { p_payment_request_id: paymentId })
  if (error || !Array.isArray(data)) {
    return {
      readable: false,
      entries: [],
      message: ledgerReadErrorMessage(error?.message, (error as { code?: string } | null)?.code),
    }
  }
  return { readable: true, entries: buildAllocationLedger(data as LedgerRpcRow[]) }
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

type Client = Pick<ReturnType<typeof createClient>, 'rpc'>

/**
 * Re-read the complete ledger, then reverse the allocation through the one
 * authorized path.
 *
 * The re-read is the same complete read the screen was drawn from, never a
 * direct table read: an allocation on a record the corrector cannot open is
 * still in it, so it is judged on what it IS rather than reported missing.
 *
 * Returns an outcome rather than throwing, so the screen can say exactly which
 * of the four happened. Success is reported ONLY from the server's answer.
 */
export async function performAllocationReversal(
  client: Client,
  input: { paymentId: string; allocation: AllocationLedgerEntry; reason: string },
): Promise<ReversalOutcome> {
  const reason = input.reason.trim()
  const blocked = correctionBlockedReason({ selected: input.allocation, reason })
  if (blocked) return { kind: 'refused', message: `${blocked} Nothing was changed.` }

  const ledger = await loadAllocationLedger(client, input.paymentId)
  if (!ledger.readable) return { kind: 'refused', message: ledger.message }

  const fresh = ledger.entries.find(e => e.allocationId === input.allocation.allocationId) ?? null
  const stale = staleAllocationReason(input.allocation, fresh)
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
