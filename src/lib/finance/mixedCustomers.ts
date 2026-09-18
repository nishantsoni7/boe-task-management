// ── One payment, more than one customer ─────────────────────────────────────
//
// A payment is normally one customer's money. BOE does, exceptionally, divide
// one receipt across records that belong to different customers — a group that
// pays for two of its hotels under two legal names, an architect paying on
// behalf of two clients. The database allows it (record_payment_with_allocations
// and allocate_payment_to_targets never compare customers), and this phase
// keeps it allowed.
//
// What changes is that it can no longer happen BY ACCIDENT. When the targets
// chosen for one payment name more than one customer, the form shows who they
// are and which record belongs to each, and will not submit until the person
// ticks a box saying that is intended. It does not block, it does not rename
// anybody, and it never writes a customer: the payment's own client_name is the
// server's (20261013000000), and such a payment keeps reading "Multiple
// customers".
//
// THE CONFIRMATION IS FOR ONE SET OF CUSTOMERS. Ticking the box for A and B does
// not carry over once C is added — the signature below changes, and the box is
// asked again.

export type CustomerTarget = {
  /** The target's customer as its own record states it. Null when unreadable. */
  clientName: string | null | undefined
  /** How the target is written for a person: "Order 0524", "PI Draft 019". */
  label: string
}

export type CustomerGroup = {
  /** The customer as first written, for display. */
  customer: string
  /** Every target in this selection that belongs to them. */
  targets: string[]
}

/**
 * The comparable form of a customer name: trimmed, inner spaces collapsed,
 * case folded. "Hotel Aurum " and "hotel  aurum" are one customer; nothing more
 * clever than that is attempted, because guessing that two different spellings
 * are one company would hide exactly the case this warning is for.
 */
export function customerKey(name: string | null | undefined): string | null {
  const key = (name ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  // '—' is what the target picker prints for a record with no customer.
  if (!key || key === '—' || key === '-') return null
  return key
}

/**
 * The selection grouped by customer, in name order. A target whose customer
 * cannot be read counts towards no group: it is not evidence of a second
 * customer, and treating it as one would warn on every restricted record.
 */
export function customerGroups(targets: readonly CustomerTarget[]): CustomerGroup[] {
  const groups = new Map<string, CustomerGroup>()
  for (const t of targets) {
    const key = customerKey(t.clientName)
    if (!key) continue
    const group = groups.get(key) ?? { customer: (t.clientName ?? '').replace(/\s+/g, ' ').trim(), targets: [] }
    if (!group.targets.includes(t.label)) group.targets.push(t.label)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => g)
}

/** "Order 0524" or "PI Draft 019" — never a uuid. */
export function customerTargetLabel(kind: 'order' | 'submission', reference: string | null | undefined): string {
  const word = kind === 'order' ? 'Order' : 'PI Draft'
  const ref = (reference ?? '').trim()
  return ref && ref !== '—' ? `${word} ${ref}` : (kind === 'order' ? 'A Confirmed Order' : 'A PI Draft')
}

/** The customer targets named by a list of allocation rows that have a record chosen. */
export function rowCustomerTargets(rows: readonly {
  kind: 'order' | 'submission' | null
  targetId: string | null
  clientName?: string | null
  reference?: string | null
}[]): CustomerTarget[] {
  return rows
    .filter(r => r.kind && r.targetId)
    .map(r => ({
      clientName: r.clientName ?? null,
      label: customerTargetLabel(r.kind as 'order' | 'submission', r.reference),
    }))
}

export function isMixedCustomerSelection(groups: readonly CustomerGroup[]): boolean {
  return groups.length > 1
}

/** Identifies one set of customers, so a confirmation cannot outlive it. */
export function customerSignature(groups: readonly CustomerGroup[]): string {
  return groups.map(g => customerKey(g.customer)).join('|')
}

export const MIXED_CUSTOMER_TITLE = 'This payment will cover more than one customer'
export const MIXED_CUSTOMER_CONFIRM_LABEL =
  'I confirm this one payment is meant to be divided between these customers.'
export const MIXED_CUSTOMER_BLOCKED_REASON =
  'These records belong to different customers. Tick the confirmation to continue, or change the records.'
