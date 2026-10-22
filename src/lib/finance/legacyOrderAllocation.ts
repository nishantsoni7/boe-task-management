// ── Allocating a payment to an OLD order that is not in this system ───────────
//
// Money often arrives for an order that predates BOE One and was never entered
// into it. Such an order cannot be picked — there is no record to pick — so the
// person types the old order's number and the client's name, and the allocation
// is stored with those two facts instead of a link (20270407000000).
//
// What this is, and is not:
//   * a real allocation: it spends part of the payment, so the payment's
//     allocated total, balance and Zero / Partially / Fully Allocated status
//     count it;
//   * NOT money for any Order or PI Draft here: no Order total, no 40% gate and
//     no PI figure ever reads it.
//
// NOTHING HERE AUTHORIZES ANYTHING. allocate_payment_to_targets() requires
// finance.allocate and re-validates every field; the checks below exist so the
// person is told before a round trip. No React, no network.

/** The longest old order number the database accepts. */
export const LEGACY_ORDER_NO_MAX = 60
/** The longest client name the database accepts. */
export const LEGACY_CLIENT_NAME_MAX = 120

/** What an old-order allocation is called wherever the kind is named. */
export const LEGACY_ORDER_WORD = 'Old order'
/** The control that adds one, and the badge that marks one. */
export const LEGACY_ORDER_ACTION_LABEL = 'Old order (not in system)'

/**
 * The comparable form of an old order number — trimmed, runs of spaces
 * collapsed, upper case. The same normalisation as normalize_legacy_order_no()
 * in the database, which stores this form and refuses a second active claim on
 * it: "ab-12" and " AB-12 " are one old order.
 */
export function normalizeLegacyOrderNo(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
}

/** The client name as stored: trimmed, inner spaces collapsed. */
export function normalizeLegacyClientName(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

/** Where an old-order row points, as one comparable value. */
export function legacyTargetKey(orderNo: string | null | undefined): string | null {
  const no = normalizeLegacyOrderNo(orderNo)
  return no ? `legacy:${no}` : null
}

/** "Old order AB-12" — the name of an old-order target, with its client when known. */
export function legacyOrderLabel(
  orderNo: string | null | undefined,
  clientName?: string | null,
): string {
  const no = normalizeLegacyOrderNo(orderNo)
  const client = normalizeLegacyClientName(clientName)
  const head = no ? `${LEGACY_ORDER_WORD} ${no}` : LEGACY_ORDER_WORD
  return client ? `${head} · ${client}` : head
}

/**
 * What is wrong with the two typed fields of an old-order row, in one sentence
 * naming the row the person is looking at, or null when both are acceptable.
 */
export function legacyRowProblem(
  row: { legacyOrderNo?: string | null; clientName?: string | null },
  position: number,
): string | null {
  const no = normalizeLegacyOrderNo(row.legacyOrderNo)
  if (!no) return `Allocation ${position}: enter the old order number.`
  if (no.length > LEGACY_ORDER_NO_MAX) {
    return `Allocation ${position}: the old order number can be at most ${LEGACY_ORDER_NO_MAX} characters.`
  }
  const client = normalizeLegacyClientName(row.clientName)
  if (!client) return `Allocation ${position}: enter the client the old order belongs to.`
  if (client.length > LEGACY_CLIENT_NAME_MAX) {
    return `Allocation ${position}: the client name can be at most ${LEGACY_CLIENT_NAME_MAX} characters.`
  }
  return null
}

/** One target of allocate_payment_to_targets() for an old order. */
export type LegacyRpcTarget = {
  legacy_order_no: string
  legacy_client_name: string
  allocated_amount: number
}

export function toLegacyRpcTarget(
  row: { legacyOrderNo?: string | null; clientName?: string | null; amount: string },
): LegacyRpcTarget {
  return {
    legacy_order_no: normalizeLegacyOrderNo(row.legacyOrderNo),
    legacy_client_name: normalizeLegacyClientName(row.clientName),
    allocated_amount: Number(row.amount),
  }
}

/** The server's refusals that only an old-order row can raise, in words. */
export function legacyAllocationErrorMessage(raw: string | null | undefined): string | null {
  const m = raw ?? ''
  if (m.includes('ALLOCATION_LEGACY_ORDER_REQUIRED')) return 'Enter the old order number. Nothing was allocated.'
  if (m.includes('ALLOCATION_LEGACY_ORDER_TOO_LONG')) {
    return `An old order number can be at most ${LEGACY_ORDER_NO_MAX} characters. Nothing was allocated.`
  }
  if (m.includes('ALLOCATION_LEGACY_CLIENT_REQUIRED')) {
    return 'Enter the client the old order belongs to. Nothing was allocated.'
  }
  if (m.includes('ALLOCATION_LEGACY_CLIENT_TOO_LONG')) {
    return `A client name can be at most ${LEGACY_CLIENT_NAME_MAX} characters. Nothing was allocated.`
  }
  return null
}
