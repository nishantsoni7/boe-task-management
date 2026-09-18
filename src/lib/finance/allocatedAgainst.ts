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
  | { kind: 'none' }
  | {
      kind: 'targets'
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
  const reserved = row.reserved_order_number?.trim() || null
  if (reserved) return `PI Draft · Reserved Order ${reserved}`
  return ref ? `PI Draft · ${ref}` : 'PI Draft'
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

  if (byTarget.size === 0) return { kind: 'none' }

  const lines: AllocatedAgainstLine[] = [...byTarget.entries()].map(([key, t]) => ({
    key,
    targetType: t.row.target_type,
    targetId: t.row.target_id,
    label: allocationTargetLabel(t.row),
    amount: exactToString(t.total),
    allocationCount: t.n,
  }))

  const amount = parseExact(payment.amount)
  const comparison = amount ? compareExact(allocated, amount) : 0
  return {
    kind: 'targets',
    lines,
    unallocated: amount && comparison < 0 ? exactToString(subtractExact(amount, allocated)) : null,
    over: amount !== null && comparison > 0,
  }
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
