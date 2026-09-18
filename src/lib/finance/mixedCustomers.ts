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

// ── The customers a payment ALREADY pays for ────────────────────────────────
//
// Allocate Funds adds to a payment that may already be divided. Which
// customers those existing allocations belong to is read ONLY from the
// complete ledger (payment_allocation_ledger_for_correction, 20261215000000) —
// never from a direct allocation read, which RLS can cut down to part of the
// ledger, and never from the payment's stored client_name, which is written
// when the payment is entered and does not follow later allocations.
//
// The complete ledger is given to finance.allocate_correct holders only. For
// anybody else the existing customers are UNKNOWN, and the warning says so
// instead of guessing — see mixedCustomerCheck.

export type ExistingCustomers =
  | { state: 'loading' }
  | { state: 'complete'; targets: CustomerTarget[] }
  | { state: 'unavailable' }

export type MixedCustomerCheck = {
  /** Show the warning and require the confirmation. */
  warn: boolean
  /** The existing allocations' customers could not be read in full. */
  incomplete: boolean
  groups: CustomerGroup[]
  /** What a confirmation is tied to; changes whenever the answer changes. */
  signature: string
}

export function mixedCustomerCheck(input: {
  existing: ExistingCustomers
  /** Records chosen in this form. Nothing chosen, nothing to ask. */
  chosen: readonly CustomerTarget[]
  /** Whether the payment already carries active allocations. */
  paymentHasAllocations: boolean
}): MixedCustomerCheck {
  const knownExisting = input.existing.state === 'complete'
  const incomplete = !knownExisting && input.paymentHasAllocations
  const groups = customerGroups([
    ...(input.existing.state === 'complete' ? input.existing.targets : []),
    ...input.chosen,
  ])
  const warn = input.chosen.length > 0 && (incomplete || isMixedCustomerSelection(groups))
  return {
    warn,
    incomplete,
    groups,
    signature: customerSignature(groups) + (incomplete ? '|existing-unknown' : ''),
  }
}

export const MIXED_CUSTOMER_INCOMPLETE_TITLE = 'Check the customers on this payment'
export const MIXED_CUSTOMER_INCOMPLETE_BLOCKED_REASON =
  'Confirm the customers on this payment to continue.'
export const MIXED_CUSTOMER_INCOMPLETE_NOTE =
  'This payment already has allocations whose customers cannot all be checked from your account. Confirm the records below belong on this payment.'

/** Identifies one set of customers, so a confirmation cannot outlive it. */
export function customerSignature(groups: readonly CustomerGroup[]): string {
  return groups.map(g => customerKey(g.customer)).join('|')
}

export const MIXED_CUSTOMER_TITLE = 'This payment will cover more than one customer'
export const MIXED_CUSTOMER_CONFIRM_LABEL =
  'I confirm this one payment is meant to be divided between these customers.'
export const MIXED_CUSTOMER_BLOCKED_REASON =
  'These records belong to different customers. Tick the confirmation to continue, or change the records.'
