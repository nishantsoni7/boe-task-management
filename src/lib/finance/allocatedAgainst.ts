// ── Allocated Against: where a confirmed payment's money has gone ─────────────
//
// The Confirmed Payments list answers "against which PI Draft or confirmed
// Order has this payment been allocated?" in one cell, without opening the
// payment. This file turns the rows of received_payment_allocation_targets()
// (20261216000000) into the lines that cell draws. No React, no network.
//
// ONLY ACTIVE ALLOCATIONS, AND ONLY THE COMPLETE SET
// --------------------------------------------------
// The input is the RPC's answer, which is the COMPLETE active ledger of each
// visible payment on the page. It is never built from:
//   * allocated_order_number — it names at most one Order;
//   * the payment's legacy order_id — a direct link is not an allocation;
//   * the caller's own RLS read of finance_payment_allocations — a participant
//     without finance.view_all receives part of a payment's allocations there.
// When the complete read failed, the cell says so ('unavailable') rather than
// "Not allocated", zero, or a partial list.
//
// SAFE NAMES
// ----------
// An Order is named by its display number. A PI Draft has no Order number of
// its own: it is named by the number RESERVED for it when there is one, or by
// its workbook's file name. The workbook's own B20 (source_order_number) is
// never used — it is normally the number of an older PI the file was copied
// from. The RPC does not even return it.

import {
  ZERO,
  addExact,
  compareExact,
  exactToString,
  parseExact,
  subtractExact,
  type ExactDecimal,
} from './exactMoney'
import type { ConfirmedAllocationStatus } from './paymentSurfaces'
import type { PaymentAllocationSummary } from './paymentAllocations'

/** One row of received_payment_allocation_targets(). */
export type AllocationTargetRow = {
  payment_request_id: string
  allocation_id: string
  target_type: 'order' | 'pi_draft'
  target_id: string
  /** Order: display number. PI Draft: workbook file name. Either may be null. */
  target_reference: string | null
  /** PI Draft only: the genuine Order number reserved for it, if any. */
  reserved_order_number: string | null
  allocated_amount: string | number | null
}

/** One destination as the cell draws it — duplicates already combined. */
export type AllocatedAgainstLine = {
  /** `${type}:${id}`, unique within one payment. */
  key: string
  targetType: 'order' | 'pi_draft'
  targetId: string
  /** "Order 0425", "PI Draft · Reserved Order 0431", "PI Draft · Hotel ABC.xlsx". */
  label: string
  /** Exact sum of every active allocation to this target, as a decimal string. */
  amount: string
  /** How many active allocation rows were combined into this line. */
  allocationCount: number
}

export type AllocatedAgainstView =
  /** The complete read has not answered yet. */
  | { kind: 'loading' }
  /** The complete read failed, or did not cover this payment. */
  | { kind: 'unavailable' }
  /** The complete read answered, and there is no active allocation. */
  | { kind: 'none'; status: ConfirmedAllocationStatus | null }
  | {
      kind: 'targets'
      /** zero / partial / full / over from the SAME exact total as the lines.
       *  Null only when the payment's own amount cannot be read. */
      status: ConfirmedAllocationStatus | null
      lines: AllocatedAgainstLine[]
      /** Payment amount minus the active total, when positive. Otherwise null. */
      unallocated: string | null
      /** The active total exceeds the payment. Shown, never clipped. */
      over: boolean
    }

export const ALLOCATED_AGAINST_LABEL = 'Allocated Against'
export const NOT_ALLOCATED_TEXT = 'Not allocated'
export const ALLOCATION_DETAILS_UNAVAILABLE_TEXT = 'Allocation details unavailable'
export const UNALLOCATED_LINE_WORD = 'Unallocated'

/** The most payment ids one call may carry — the RPC refuses more. */
export const ALLOCATION_TARGETS_MAX_IDS = 50

/** The readable name of one target. Never a bare id, never source_order_number. */
export function allocationTargetLabel(row: Pick<AllocationTargetRow,
  'target_type' | 'target_reference' | 'reserved_order_number'>): string {
  const ref = row.target_reference?.trim() || null
  if (row.target_type === 'order') return ref ? `Order ${ref}` : 'Order'
  const name = allocationTargetName(row)
  return name ? `PI Draft · ${name}` : 'PI Draft'
}

/** A draft's stable reference (20270102000000), e.g. "PID-00012". */
const PID = /^PID-\d+$/

/**
 * A PI Draft's name: its STABLE reference (PID-00012, 20270104000000), with the
 * Order number it has reserved beside it when it holds one — that is the
 * number the Order will take. A draft read before it had a reference falls
 * back to the reserved number, then the workbook's file name.
 */
function draftName(reference: string | null, reserved: string | null): string | null {
  if (reference && PID.test(reference)) return reserved ? `${reference} · Reserved ${reserved}` : reference
  if (reserved) return `Reserved Order ${reserved}`
  return reference
}

/**
 * A destination's name WITHOUT its kind word, for surfaces that print the kind
 * separately ("Order 0425", "PI Draft · Reserved Order 0431"). Null when there
 * is no safe reference. Never source_order_number.
 */
export function allocationTargetName(row: Pick<AllocationTargetRow,
  'target_type' | 'target_reference' | 'reserved_order_number'>): string | null {
  const ref = row.target_reference?.trim() || null
  if (row.target_type === 'order') return ref
  return draftName(ref, row.reserved_order_number?.trim() || null)
}

/** Safe names for every destination in the complete read, keyed by target id. */
export function allocationTargetNames(rows: readonly AllocationTargetRow[] | null): Map<string, string> {
  const names = new Map<string, string>()
  for (const row of rows ?? []) {
    const name = allocationTargetName(row)
    if (name && row.target_id) names.set(row.target_id, name)
  }
  return names
}

/**
 * The same name, for a PI Draft row read directly from order_submissions
 * (the reader's own RLS read): its PID (with a reserved number beside it),
 * otherwise the reserved Order number, otherwise the workbook's file name.
 * NEVER source_order_number: that is normally the number of an older PI the
 * workbook was copied from.
 */
export function piDraftSafeName(row: {
  draft_reference?: string | null
  reserved_order_number?: string | null
  source_workbook_name?: string | null
}): string {
  const reserved = row.reserved_order_number?.trim() || null
  const named = draftName(row.draft_reference?.trim() || null, reserved)
  if (named) return named
  const file = (row.source_workbook_name ?? '').replace(/^.*[\\/]/, '').trim()
  return file || 'Draft'
}

/** The columns piDraftSafeName reads, for the two direct reads that use it. */
export const PI_DRAFT_NAME_COLUMNS = 'id, draft_reference, reserved_order_number, source_workbook_name'

/**
 * Give a detail-panel allocation summary the safe names the complete read
 * knows. A target that already has a name keeps it; a target the reader's own
 * RLS could not name gets the complete read's name instead of "A PI Draft".
 */
export function nameSummaryTargets<T extends { targets: { targetId: string; label: string | null }[] }>(
  summary: T,
  names: ReadonlyMap<string, string>,
): T {
  if (names.size === 0) return summary
  return {
    ...summary,
    targets: summary.targets.map(t => (t.label ? t : { ...t, label: names.get(t.targetId) ?? null })),
  }
}

/** "3 allocations" — the count of distinct destinations, shown when several. */
export function allocationCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'allocation' : 'allocations'}`
}

/**
 * The cell for one payment.
 *
 * `rows` is null while the complete read is in flight and `readFailed` is true
 * when it could not be made; either way no line is guessed. Rows for other
 * payments are ignored, so the whole page's answer can be passed in.
 */
export function buildAllocatedAgainst(
  payment: { id: string; amount: string | number | null },
  rows: readonly AllocationTargetRow[] | null,
  options: { readFailed?: boolean; covered?: boolean } = {},
): AllocatedAgainstView {
  if (options.readFailed) return { kind: 'unavailable' }
  if (rows === null) return { kind: 'loading' }
  // The read answered, but not for this payment (e.g. a row spliced in after
  // it ran). Silence from the RPC is "no active allocation" only for an id it
  // was actually asked about.
  if (options.covered === false) return { kind: 'unavailable' }

  const byTarget = new Map<string, { row: AllocationTargetRow; total: ExactDecimal; n: number }>()
  let allocated: ExactDecimal = ZERO

  for (const row of rows) {
    if (row.payment_request_id !== payment.id || !row.target_id) continue
    const share = parseExact(row.allocated_amount)
    // An amount that cannot be read exactly is a data defect; the cell must not
    // quietly print a smaller total than the ledger holds.
    if (!share) return { kind: 'unavailable' }
    allocated = addExact(allocated, share)
    const key = `${row.target_type}:${row.target_id}`
    const existing = byTarget.get(key)
    if (existing) {
      existing.total = addExact(existing.total, share)
      existing.n += 1
    } else {
      byTarget.set(key, { row, total: share, n: 1 })
    }
  }

  const amount = parseExact(payment.amount)
  if (byTarget.size === 0) return { kind: 'none', status: amount ? 'zero' : null }

  const lines: AllocatedAgainstLine[] = [...byTarget.entries()].map(([key, t]) => ({
    key,
    targetType: t.row.target_type,
    targetId: t.row.target_id,
    label: allocationTargetLabel(t.row),
    amount: exactToString(t.total),
    allocationCount: t.n,
  }))

  const comparison = amount ? compareExact(allocated, amount) : 0
  return {
    kind: 'targets',
    status: allocationStatusFromTotal(amount, allocated),
    lines,
    unallocated: amount && comparison < 0 ? exactToString(subtractExact(amount, allocated)) : null,
    over: amount !== null && comparison > 0,
  }
}

/**
 * THE STATUS RULE, restated in exact decimals. The database's single
 * definition is received_payment_allocation_status() (20261216000000 §2), which
 * the list's server-side filter uses; this must agree with it case for case:
 *   zero    total = 0          partial  0 < total < amount
 *   full    total = amount     over     total > amount
 * No floating point: both sides are ExactDecimal.
 */
export function allocationStatusFromTotal(
  amount: ExactDecimal | null,
  activeTotal: ExactDecimal,
): ConfirmedAllocationStatus | null {
  if (!amount) return null
  if (compareExact(activeTotal, ZERO) <= 0) return 'zero'
  const c = compareExact(activeTotal, amount)
  return c > 0 ? 'over' : c === 0 ? 'full' : 'partial'
}

/**
 * What the Allocation Status badge may say for this cell. Never a status while
 * the complete read is in flight or after it failed: a confident Zero or Full
 * drawn from nothing would be the defect this column exists to remove.
 */
export function allocationBadgeState(
  view: AllocatedAgainstView,
): ConfirmedAllocationStatus | 'loading' | 'unavailable' {
  if (view.kind === 'loading') return 'loading'
  if (view.kind === 'unavailable') return 'unavailable'
  return view.status ?? 'unavailable'
}

/** Plain-text form of the cell, for accessible names and tooltips. */
export function allocatedAgainstText(view: AllocatedAgainstView, formatMoney: (v: string) => string): string {
  switch (view.kind) {
    case 'loading':     return 'Loading allocation details'
    case 'unavailable': return ALLOCATION_DETAILS_UNAVAILABLE_TEXT
    case 'none':        return NOT_ALLOCATED_TEXT
    case 'targets': {
      const parts = view.lines.map(l => `${l.label} · ${formatMoney(l.amount)}`)
      if (view.unallocated) parts.push(`${UNALLOCATED_LINE_WORD} · ${formatMoney(view.unallocated)}`)
      const head = view.lines.length > 1 ? `${allocationCountLabel(view.lines.length)}: ` : ''
      return head + parts.join('; ')
    }
  }
}

// ── The COMPLETE figures, for readers whose own RLS sees only part ───────────
//
// LAUNCH AUDIT (2026-09-19). A Finance reader without finance.view_all reads a
// payment's allocations through RLS, which returns only the allocations whose
// target they may open. Two screens used that partial read as if it were the
// whole ledger:
//
//   * the payment's detail panel printed "Allocated ₹50,000 / Remaining
//     ₹50,000" for a ₹1,00,000 payment that also had ₹40,000 on an Order the
//     reader cannot open — while the list row, from the complete read, said
//     "Unallocated ₹10,000";
//   * Allocate Funds offered ₹50,000 as the remaining balance, which the server
//     then refused (only ₹10,000 was free).
//
// The complete answer is already on the page: received_payment_allocation_
// targets() (20261216000000) returns every ACTIVE allocation of each payment the
// reader may read, with safe labels only. These two functions derive the panel
// summary and the existing total from it, with the same exact decimals as the
// list. They return null when that read did not cover the payment — the caller
// then keeps its previous, conservative behaviour.

/** The ACTIVE total of one payment from the complete read, or null if uncovered. */
export function completeAllocatedTotal(
  paymentId: string,
  rows: readonly AllocationTargetRow[] | null,
  options: { covered: boolean; readFailed?: boolean },
): string | null {
  if (options.readFailed || rows === null || !options.covered) return null
  let total: ExactDecimal = ZERO
  for (const row of rows) {
    if (row.payment_request_id !== paymentId) continue
    const share = parseExact(row.allocated_amount)
    if (!share) return null
    total = addExact(total, share)
  }
  return exactToString(total)
}

/**
 * One payment's allocation summary from the complete read — one entry per
 * ACTIVE ledger row (the history stays separate here; only the list combines
 * duplicates), state and remainder in exact decimals. Null if uncovered.
 */
export function completeAllocationSummary(
  payment: { id: string; amount: string | number | null },
  rows: readonly AllocationTargetRow[] | null,
  options: { covered: boolean; readFailed?: boolean },
): PaymentAllocationSummary | null {
  const total = completeAllocatedTotal(payment.id, rows, options)
  if (total === null || rows === null) return null
  const allocated = parseExact(total) ?? ZERO
  const targets = rows
    .filter(r => r.payment_request_id === payment.id)
    .map(r => ({
      allocationId: r.allocation_id,
      kind: r.target_type === 'order' ? 'order' as const : 'submission' as const,
      targetId: r.target_id,
      label: null,
      amount: exactToString(parseExact(r.allocated_amount) ?? ZERO),
    }))
  const amount = parseExact(payment.amount)
  if (!amount) {
    return { paymentId: payment.id, state: 'unknown', allocated: total, unallocated: null, targets }
  }
  const comparison = compareExact(allocated, amount)
  return {
    paymentId: payment.id,
    state: compareExact(allocated, ZERO) <= 0 ? 'unallocated'
      : comparison > 0 ? 'over'
      : comparison === 0 ? 'full'
      : 'partial',
    allocated: total,
    unallocated: comparison >= 0 ? exactToString(ZERO) : exactToString(subtractExact(amount, allocated)),
    targets,
  }
}
