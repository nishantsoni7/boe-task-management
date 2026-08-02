// Order amendments — the rules an Amend Order form and a Request a Change form
// both have to satisfy, kept out of the pages so they can be tested.
//
// Storage, authorization and the audit row live in
// supabase/migrations/20260804000000_order_amendments.sql. Everything here is
// client-side shaping and pre-validation: the database re-checks all of it, and
// the definer functions (amend_order, approve_order_change_request) are the only
// things that can actually move an Order.
//
// The one rule worth reading before anything else: NULL means "leave this field
// alone". Both database doors COALESCE every proposed value against the stored
// one, so a field this module reports as null is a field the amendment will not
// touch. The consequence is deliberate and load-bearing — neither door can blank
// a value back to NULL, so a form that submits an empty box cannot silently
// erase an order's due date.

// ── The amendable fields ──────────────────────────────────────────────────────
// These eight are exactly the columns apply_order_amendment() writes. Anything
// not in this list is either frozen (created_by, created_at), guarded elsewhere
// (display_number, the source_* provenance pair) or operational (status, which
// moves through the transition graph, not through an amendment).

export type AmendableField =
  | 'client_name'
  | 'total_value'
  | 'total_product_value'
  | 'confirm_date'
  | 'due_date'
  | 'lead_source'
  | 'notes'

export type AmendableFieldKind = 'text' | 'money' | 'date' | 'lead_source' | 'notes'

export const AMENDABLE_FIELDS: {
  key: AmendableField
  label: string
  kind: AmendableFieldKind
}[] = [
  { key: 'client_name',         label: 'Client Name',         kind: 'text' },
  { key: 'total_product_value', label: 'Total Product Value', kind: 'money' },
  { key: 'total_value',         label: 'Total Order Value',   kind: 'money' },
  { key: 'confirm_date',        label: 'Confirm Date',        kind: 'date' },
  { key: 'due_date',            label: 'Due Date',            kind: 'date' },
  { key: 'lead_source',         label: 'Lead Source',         kind: 'lead_source' },
  { key: 'notes',               label: 'Notes',               kind: 'notes' },
]

export const AMENDABLE_FIELD_LABEL: Record<AmendableField, string> =
  AMENDABLE_FIELDS.reduce((acc, f) => {
    acc[f.key] = f.label
    return acc
  }, {} as Record<AmendableField, string>)

// Same five the orders.lead_source CHECK accepts. Kept here so the form cannot
// offer a sixth that the database would refuse.
export const LEAD_SOURCE_VALUES = [
  'reference',
  'repeat_customer',
  'whatsapp',
  'instagram',
  'website',
] as const

export type LeadSource = typeof LEAD_SOURCE_VALUES[number]

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  reference:       'Reference',
  repeat_customer: 'Repeat Customer',
  whatsapp:        'WhatsApp',
  instagram:       'Instagram',
  website:         'Website',
}

export function isLeadSource(value: string): value is LeadSource {
  return (LEAD_SOURCE_VALUES as readonly string[]).includes(value)
}

// ── What an amendable Order looks like from here ──────────────────────────────

export type AmendableOrder = {
  status: string
  client_name: string
  total_value: number | null
  total_product_value: number | null
  confirm_date: string | null
  due_date: string | null
  lead_source: string | null
  notes: string | null
}

// A dispatched or cancelled Order is finished. apply_order_amendment refuses
// both with ORDER_CLOSED; this is the same rule, early enough to not offer the
// button. Not a permission check — see canRequestOrderChange for that half.
export const CLOSED_ORDER_STATUSES = ['dispatched', 'cancelled'] as const

export function isAmendableStatus(status: string): boolean {
  return !(CLOSED_ORDER_STATUSES as readonly string[]).includes(status)
}

// ── Form state ────────────────────────────────────────────────────────────────
// Every field is a string, because every field comes from an <input>. Parsing
// happens once, in buildAmendmentPayload, so there is one place where "" and
// "0" and "abc" are told apart.

export type AmendFormState = Record<AmendableField, string>

function moneyToInput(n: number | null): string {
  return n == null ? '' : String(n)
}

/**
 * The form pre-filled with what the Order currently holds. Pre-filling is what
 * makes "leave it alone" the default: an untouched field parses back to the
 * same value and drops out of the payload as unchanged.
 */
export function initialAmendState(order: AmendableOrder): AmendFormState {
  return {
    client_name:         order.client_name ?? '',
    total_value:         moneyToInput(order.total_value),
    total_product_value: moneyToInput(order.total_product_value),
    confirm_date:        order.confirm_date ?? '',
    due_date:            order.due_date ?? '',
    lead_source:         order.lead_source ?? '',
    notes:               order.notes ?? '',
  }
}

// ── Money ─────────────────────────────────────────────────────────────────────
// Accepts what a person actually types into a rupee field: separators, a
// currency symbol, surrounding space. Rejects anything that is not then a
// finite, non-negative number — the same rule as the table's
// order_change_requests_values_non_negative CHECK and apply_order_amendment's
// ORDER_VALUE_NEGATIVE guard.

export type ParsedMoney =
  | { ok: true; value: number | null }
  | { ok: false; error: string }

export function parseMoney(raw: string): ParsedMoney {
  const cleaned = raw.replace(/[₹,\s]/g, '')
  if (cleaned === '') return { ok: true, value: null }

  const n = Number(cleaned)
  if (!Number.isFinite(n)) return { ok: false, error: 'Enter a valid amount.' }
  if (n < 0)               return { ok: false, error: 'An amount cannot be negative.' }

  // numeric(12,2): two decimal places, and at most ten digits before them.
  const rounded = Math.round(n * 100) / 100
  if (rounded >= 1e10) return { ok: false, error: 'That amount is too large to store.' }

  return { ok: true, value: rounded }
}

// ── The payload ───────────────────────────────────────────────────────────────
// One key per amendable field, every key always present, and null wherever the
// value did not change. Always-present keys are what make this safe to spread
// into an RPC call: an omitted key and a null key mean the same thing to the
// database, but only the explicit null makes that visible in the diff a reader
// is checking.

export type AmendmentPayload = {
  p_client_name:         string | null
  p_total_value:         number | null
  p_total_product_value: number | null
  p_confirm_date:        string | null
  p_due_date:            string | null
  p_lead_source:         string | null
  p_notes:               string | null
}

export const EMPTY_AMENDMENT_PAYLOAD: AmendmentPayload = {
  p_client_name:         null,
  p_total_value:         null,
  p_total_product_value: null,
  p_confirm_date:        null,
  p_due_date:            null,
  p_lead_source:         null,
  p_notes:               null,
}

export type BuiltAmendment =
  | { ok: true; payload: AmendmentPayload; changed: AmendableField[] }
  | { ok: false; field: AmendableField; error: string }

// A date column takes a real calendar date, not merely ten characters in the
// right shape. The round-trip is what rejects 2026-02-31: Date normalises it to
// 2026-03-03, which no longer matches the input.
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(value + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

function textChanged(next: string, prev: string | null): string | null {
  const n = next.trim()
  const p = (prev ?? '').trim()
  // An emptied box is "leave it alone", never "blank it" — see the module note.
  if (n === '' || n === p) return null
  return n
}

/**
 * What actually changed, as the RPC wants it.
 *
 * A failure names the field, so the form can put the message next to the box
 * that caused it rather than at the top of the modal.
 */
export function buildAmendmentPayload(
  order: AmendableOrder,
  form: AmendFormState,
): BuiltAmendment {
  const payload: AmendmentPayload = { ...EMPTY_AMENDMENT_PAYLOAD }
  const changed: AmendableField[] = []

  const client = textChanged(form.client_name, order.client_name)
  if (client !== null) { payload.p_client_name = client; changed.push('client_name') }

  const money: [AmendableField, (v: number) => void, number | null][] = [
    ['total_value',         v => { payload.p_total_value = v },         order.total_value],
    ['total_product_value', v => { payload.p_total_product_value = v }, order.total_product_value],
  ]
  for (const [field, assign, current] of money) {
    const parsed = parseMoney(form[field])
    if (!parsed.ok) return { ok: false, field, error: parsed.error }
    if (parsed.value !== null && parsed.value !== current) {
      assign(parsed.value)
      changed.push(field)
    }
  }

  const dates: [AmendableField, (v: string) => void, string | null][] = [
    ['confirm_date', v => { payload.p_confirm_date = v }, order.confirm_date],
    ['due_date',     v => { payload.p_due_date     = v }, order.due_date],
  ]
  for (const [field, assign, current] of dates) {
    const next = textChanged(form[field], current)
    if (next !== null) {
      if (!isCalendarDate(next)) {
        return { ok: false, field, error: 'Enter a valid date.' }
      }
      assign(next)
      changed.push(field)
    }
  }

  const lead = textChanged(form.lead_source, order.lead_source)
  if (lead !== null) {
    if (!isLeadSource(lead)) {
      return { ok: false, field: 'lead_source', error: 'Choose one of the listed lead sources.' }
    }
    payload.p_lead_source = lead
    changed.push('lead_source')
  }

  const notes = textChanged(form.notes, order.notes)
  if (notes !== null) { payload.p_notes = notes; changed.push('notes') }

  return { ok: true, payload, changed }
}

/**
 * Why this amendment cannot be submitted yet, or null when it can.
 *
 * The no-change case is a refusal rather than a silent success because the
 * database refuses it too (ORDER_AMENDMENT_NO_CHANGE): an amendment that
 * changes nothing would write an audit row saying nothing happened.
 */
export function validateAmendment(input: {
  reason: string
  changed: AmendableField[]
}): string | null {
  if (input.reason.trim() === '') return 'Say why this order is being amended.'
  if (input.changed.length === 0)  return 'Change at least one value before submitting.'
  return null
}

// ── Proposed-column mapping for a change request ──────────────────────────────
// The RPC takes p_* arguments; the order_change_requests table takes proposed_*
// columns. Same seven values, two names, so one conversion in one place.

export type ProposedOrderFields = {
  proposed_client_name:         string | null
  proposed_total_value:         number | null
  proposed_total_product_value: number | null
  proposed_confirm_date:        string | null
  proposed_due_date:            string | null
  proposed_lead_source:         string | null
  proposed_notes:               string | null
}

// What the Order held when the request was filed, captured server-side by
// capture_order_change_baseline (20260806000000). Never sent by a client — a
// requester who could supply their own baseline could suppress the staleness
// check that approval depends on. Present here so the review UI can show an
// admin what the requester was actually looking at.
export type BaselineOrderFields = {
  baseline_client_name:         string | null
  baseline_total_value:         number | null
  baseline_total_product_value: number | null
  baseline_confirm_date:        string | null
  baseline_due_date:            string | null
  baseline_lead_source:         string | null
  baseline_notes:               string | null
}

export function toProposedFields(payload: AmendmentPayload): ProposedOrderFields {
  return {
    proposed_client_name:         payload.p_client_name,
    proposed_total_value:         payload.p_total_value,
    proposed_total_product_value: payload.p_total_product_value,
    proposed_confirm_date:        payload.p_confirm_date,
    proposed_due_date:            payload.p_due_date,
    proposed_lead_source:         payload.p_lead_source,
    proposed_notes:               payload.p_notes,
  }
}

// ── Change requests ───────────────────────────────────────────────────────────

export type OrderChangeRequestType = 'edit' | 'cancel'
export type OrderChangeRequestStatus = 'pending' | 'approved' | 'rejected'

export type OrderChangeRequest = {
  id: string
  order_id: string
  order_number_snapshot: string
  request_type: OrderChangeRequestType
  requested_by: string
  requested_by_name?: string
  reason: string
  status: OrderChangeRequestStatus
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
} & ProposedOrderFields & Partial<BaselineOrderFields>

export const CHANGE_REQUEST_TYPE_LABEL: Record<OrderChangeRequestType, string> = {
  edit:   'Change to Order',
  cancel: 'Order Cancellation',
}

export const CHANGE_REQUEST_STATUS_LABEL: Record<OrderChangeRequestStatus, string> = {
  pending:  'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
}

/**
 * Does this person already have an open request of this type against this
 * Order? Mirrors order_change_requests_one_pending_idx, so the UI can say
 * "Change already requested" instead of letting the insert die on a constraint.
 */
export function hasPendingChangeRequest(
  requests: Pick<OrderChangeRequest, 'order_id' | 'requested_by' | 'request_type' | 'status'>[],
  orderId: string,
  requestedBy: string,
  type: OrderChangeRequestType,
): boolean {
  return requests.some(r =>
    r.status === 'pending' &&
    r.order_id === orderId &&
    r.requested_by === requestedBy &&
    r.request_type === type,
  )
}

/** A reviewed request can never be reviewed again. */
export function canReviewChangeRequest(request: Pick<OrderChangeRequest, 'status'>): boolean {
  return request.status === 'pending'
}

/**
 * One line per proposed field, as `Label: baseline → proposed`.
 *
 * The baseline half is what makes this reviewable rather than merely readable:
 * "Total Order Value: ₹2,50,000 → ₹3,00,000" tells an admin what is being
 * replaced, and — when the order has moved since — that the request was written
 * against a figure that is no longer current. Requests filed before
 * 20260806000000 carry no baseline, so those fall back to showing the proposal
 * alone rather than inventing a "from" value.
 */
export function describeProposal(request: OrderChangeRequest): string[] {
  const pairs: [AmendableField, unknown, unknown][] = [
    ['client_name',         request.baseline_client_name,         request.proposed_client_name],
    ['total_product_value', request.baseline_total_product_value, request.proposed_total_product_value],
    ['total_value',         request.baseline_total_value,         request.proposed_total_value],
    ['confirm_date',        request.baseline_confirm_date,        request.proposed_confirm_date],
    ['due_date',            request.baseline_due_date,            request.proposed_due_date],
    ['lead_source',         request.baseline_lead_source,         request.proposed_lead_source],
    ['notes',               request.baseline_notes,               request.proposed_notes],
  ]

  return pairs
    .filter(([, , proposed]) => proposed !== null && proposed !== undefined)
    .map(([field, baseline, proposed]) => {
      const label = AMENDABLE_FIELD_LABEL[field]
      const to = displayValue(field, proposed)
      return baseline === undefined
        ? `${label}: ${to}`
        : `${label}: ${displayValue(field, baseline)} → ${to}`
    })
}

/**
 * Which proposed fields no longer match the Order — the client-side mirror of
 * the staleness gate in approve_order_change_request.
 *
 * Advisory only. The database re-derives this under a row lock and is what
 * actually refuses; this exists so an admin sees the conflict on the page
 * instead of discovering it by having their approval rejected.
 */
export function staleProposalFields(
  request: OrderChangeRequest,
  order: AmendableOrder,
): string[] {
  const pairs: [AmendableField, unknown, unknown, unknown][] = [
    ['client_name',         request.proposed_client_name,         request.baseline_client_name,         order.client_name],
    ['total_product_value', request.proposed_total_product_value, request.baseline_total_product_value, order.total_product_value],
    ['total_value',         request.proposed_total_value,         request.baseline_total_value,         order.total_value],
    ['confirm_date',        request.proposed_confirm_date,        request.baseline_confirm_date,        order.confirm_date],
    ['due_date',            request.proposed_due_date,            request.baseline_due_date,            order.due_date],
    ['lead_source',         request.proposed_lead_source,         request.baseline_lead_source,         order.lead_source],
    ['notes',               request.proposed_notes,               request.baseline_notes,               order.notes],
  ]

  return pairs
    // A request with no baseline predates the column and cannot be judged
    // stale here. The database applies the same rule.
    .filter(([, proposed, baseline, current]) =>
      proposed !== null && proposed !== undefined &&
      baseline !== undefined &&
      (baseline ?? null) !== (current ?? null))
    .map(([field]) => AMENDABLE_FIELD_LABEL[field])
}

// ── Who sees which door ───────────────────────────────────────────────────────
// Two questions, deliberately separate. An admin amends; everyone else who can
// see the Order asks. Both are gated on the Order still being open, and neither
// is the actual authority — assert_order_amender() and the insert policy are.

export function canAmendOrderDirectly(
  profile: { role?: string | null } | null,
  order: Pick<AmendableOrder, 'status'>,
): boolean {
  return profile?.role === 'admin' && isAmendableStatus(order.status)
}

export function canRequestOrderChange(
  profile: { role?: string | null } | null,
  order: Pick<AmendableOrder, 'status'>,
): boolean {
  if (!profile) return false
  if (profile.role === 'admin') return false   // they have the direct door
  return isAmendableStatus(order.status)
}

// ── Reading an amendment back ─────────────────────────────────────────────────
// The shape apply_order_amendment writes into order_activity_log.payload.

export type AmendmentChangeEntry = { from: unknown; to: unknown }

export type AmendedActivityPayload = {
  source?: string
  reason?: string
  request_id?: string | null
  changes?: Record<string, AmendmentChangeEntry>
}

function displayValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (field === 'total_value' || field === 'total_product_value') {
    const n = Number(value)
    return Number.isFinite(n) ? '₹' + n.toLocaleString('en-IN') : String(value)
  }
  if (field === 'lead_source') {
    const v = String(value)
    return isLeadSource(v) ? LEAD_SOURCE_LABEL[v] : v
  }
  return String(value)
}

/**
 * One line per field that moved, in the fixed order of AMENDABLE_FIELDS so two
 * amendments always read the same way down the page. Unknown keys are kept
 * rather than dropped — a payload written by a later migration should still be
 * legible here instead of silently disappearing from the audit trail.
 */
export function describeAmendment(payload: AmendedActivityPayload): string[] {
  const changes = payload.changes ?? {}
  const known = AMENDABLE_FIELDS.map(f => f.key as string).filter(k => k in changes)
  const unknown = Object.keys(changes).filter(k => !known.includes(k))

  return [...known, ...unknown].map(key => {
    const entry = changes[key]
    const label = AMENDABLE_FIELD_LABEL[key as AmendableField] ?? key.replace(/_/g, ' ')
    return `${label}: ${displayValue(key, entry.from)} → ${displayValue(key, entry.to)}`
  })
}

// ── Failure messages ──────────────────────────────────────────────────────────
// Every refusal in the migration carries a greppable code prefix, one per rule.
// Each maps to a sentence naming the rule that refused, so the reader knows
// whether to change a value, reload, or ask someone else — never a single
// "please try again" that hides which of them it was.
//
// Returns null when the failure is not an amendment failure, so the caller falls
// through to its own generic mapping rather than mislabelling an unrelated error.

export function amendmentErrorMessage(message: string | null | undefined): string | null {
  const m = message ?? ''

  if (m.includes('ORDER_AMENDMENT_REQUIRED')) {
    return 'The terms of an order can only be changed through an amendment. Reload the page and use Amend Order.'
  }
  if (m.includes('ORDER_FIELD_FROZEN')) {
    return "An order's creation record can never be changed."
  }
  if (m.includes('ORDER_AMENDMENT_FORBIDDEN')) {
    return 'Only an administrator can amend an order. Submit a change request instead.'
  }
  if (m.includes('ORDER_AMENDMENT_NO_CHANGE')) {
    return 'Nothing was changed — every value submitted matches what the order already holds.'
  }
  if (m.includes('ORDER_AMENDMENT_NO_REASON')) {
    return 'An amendment must say why.'
  }
  if (m.includes('ORDER_CANCEL_NO_REASON')) {
    return 'A cancellation must say why.'
  }
  if (m.includes('ORDER_VALUE_NEGATIVE')) {
    return 'An order value cannot be negative.'
  }
  if (m.includes('ORDER_CLIENT_NAME_EMPTY')) {
    return 'An order must always name a client.'
  }
  if (m.includes('ORDER_ALREADY_CANCELLED')) {
    return 'This order has already been cancelled.'
  }
  if (m.includes('ORDER_DISPATCHED')) {
    return 'This order has already been dispatched and can no longer be cancelled.'
  }
  if (m.includes('ORDER_CLOSED')) {
    return 'This order is closed. Its terms can no longer be amended.'
  }
  if (m.includes('ORDER_CHANGE_REQUEST_REVIEWED')) {
    return 'This request has already been reviewed by someone else. Refresh to see the decision.'
  }
  // Checked before ORDER_CHANGE_REQUEST_MISSING for the same reason
  // ORDER_DISPATCHED is checked before ORDER_CLOSED: both share a prefix, and
  // the specific message is the actionable one.
  if (m.includes('ORDER_CHANGE_REQUEST_STALE')) {
    return 'This order changed after the request was raised, so approving it would undo the newer values. Review the order as it stands now, then ask for a fresh request if the change is still wanted.'
  }
  if (m.includes('ORDER_CHANGE_REQUEST_MISSING')) {
    return 'This request no longer exists. Refresh the list.'
  }
  if (m.includes('ORDER_NOT_FOUND')) {
    return 'That order no longer exists.'
  }
  if (m.includes('order_change_requests_one_pending_idx')) {
    return 'You already have an open request of this kind on this order. Wait for it to be reviewed.'
  }
  if (m.includes('order_change_requests_values_non_negative')) {
    return 'An order value cannot be negative.'
  }
  return null
}
