// THE FOUR FIELDS A CONFIRMED ORDER CANNOT BE BUILT WITHOUT.
//
// Salesperson, confirm date, due date and lead source. The rule lives here so
// the approval dialog, the page that calls the RPC and the tests all state it
// once; the AUTHORITY is approve_order_submission() (20261201000000), which
// re-derives every one of them BEFORE ANY CONVERSION-SIDE STATE CHANGE OR
// ORDER CREATION: after the actor is authorized and the submission row is
// locked and read, and before the payment position is read, before any
// allocation moves and before the Order exists.
//
// NOTHING HERE AUTHORIZES AND NOTHING HERE IS A CONTROL. A screen that refuses
// to submit is a courtesy to the person filling it in. A stale tab, a replayed
// request and a hand-made PostgREST call all reach the database gate.
//
// ONE WORD FOR ONE PERSON. On an Order the responsible person is the
// SALESPERSON, and that is the only word the Order flow uses for them. The
// column underneath is orders.assigned_to, which every Order screen used to
// call "Assignee" and the detail page also called "Owner" — three names for
// one fact. The column is NOT renamed: a database rename to change a label
// would move every policy, index and query that reads it, for nothing.

/** The label the whole Order flow uses. Never "Owner", never "Assignee". */
export const SALESPERSON_LABEL = 'Salesperson'

// ── Lead source ───────────────────────────────────────────────────────────────
//
// THE EXISTING FIVE. public.orders has carried this CHECK constraint since
// 20260655_create_orders.sql and the values are unchanged: this task makes the
// field required, it does not invent a taxonomy. The labels were duplicated in
// two Order screens; they are said once here.

export const ORDER_LEAD_SOURCES = [
  { value: 'reference',       label: 'Reference' },
  { value: 'repeat_customer', label: 'Repeat Customer' },
  { value: 'whatsapp',        label: 'WhatsApp' },
  { value: 'instagram',       label: 'Instagram' },
  { value: 'website',         label: 'Website' },
] as const

export type OrderLeadSource = typeof ORDER_LEAD_SOURCES[number]['value']

export const LEAD_SOURCE_LABEL: Record<string, string> =
  Object.fromEntries(ORDER_LEAD_SOURCES.map(s => [s.value, s.label]))

export function isOrderLeadSource(value: unknown): value is OrderLeadSource {
  return typeof value === 'string' && ORDER_LEAD_SOURCES.some(s => s.value === value)
}

/** A stored value BOE no longer offers still reads as itself, never as a blank. */
export function leadSourceLabel(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (raw === '') return null
  return LEAD_SOURCE_LABEL[raw] ?? raw
}

// ── The four fields ───────────────────────────────────────────────────────────

export const ORDER_CONFIRMATION_FIELDS = ['salesperson', 'confirm_date', 'due_date', 'lead_source'] as const
export type OrderConfirmationField = typeof ORDER_CONFIRMATION_FIELDS[number]

export const ORDER_CONFIRMATION_LABEL: Record<OrderConfirmationField, string> = {
  salesperson:  SALESPERSON_LABEL,
  confirm_date: 'Confirm date',
  due_date:     'Due date',
  lead_source:  'Lead source',
}

/**
 * What to say when one is missing.
 *
 * EACH NAMES ITS OWN FIELD. "Please complete the required fields" makes the
 * reader hunt; these say which one and what to do, and the dialog focuses it.
 */
export const ORDER_CONFIRMATION_MESSAGE: Record<OrderConfirmationField, string> = {
  salesperson:  'Select a salesperson before confirming this Order.',
  confirm_date: 'Set the confirm date before confirming this Order.',
  due_date:     'Set the due date before confirming this Order.',
  lead_source:  'Select the lead source before confirming this Order.',
}

export type OrderConfirmationDraft = {
  /** users.id — written to orders.assigned_to. */
  salesperson: string | null
  /** YYYY-MM-DD, as a date input gives it. */
  confirmDate: string | null
  dueDate: string | null
  leadSource: string | null
}

export type OrderConfirmationValues = {
  salesperson: string
  confirmDate: string
  dueDate: string
  leadSource: OrderLeadSource
}

export type OrderConfirmationCheck =
  | { ok: true; values: OrderConfirmationValues }
  | { ok: false; field: OrderConfirmationField; message: string }

/** A strict `YYYY-MM-DD` that is also a real day — the same shape dueDate.ts
 *  requires of a PI, so a date typed here and a date parsed from a workbook
 *  cannot mean different things. */
export function isCalendarDate(value: string | null | undefined): value is string {
  const s = (value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return false
  return d.toISOString().slice(0, 10) === s
}

/**
 * The first field that is not ready, in the order they are asked for — so a
 * dialog can focus one field and say one sentence rather than listing four.
 */
export function validateOrderConfirmation(draft: OrderConfirmationDraft): OrderConfirmationCheck {
  const salesperson = (draft.salesperson ?? '').trim()
  if (salesperson === '') return fail('salesperson')

  const confirmDate = (draft.confirmDate ?? '').trim()
  if (!isCalendarDate(confirmDate)) return fail('confirm_date')

  const dueDate = (draft.dueDate ?? '').trim()
  if (!isCalendarDate(dueDate)) return fail('due_date')

  const leadSource = (draft.leadSource ?? '').trim()
  if (!isOrderLeadSource(leadSource)) return fail('lead_source')

  return { ok: true, values: { salesperson, confirmDate, dueDate, leadSource } }
}

function fail(field: OrderConfirmationField): OrderConfirmationCheck {
  return { ok: false, field, message: ORDER_CONFIRMATION_MESSAGE[field] }
}

// ── What the database says, in the same words ─────────────────────────────────
//
// The RPC raises a CODE; the sentence is chosen here, from a table this bundle
// owns. The server's own message is never rendered — an unrecognised code
// degrades to the generic answer rather than printing a token from the wire.

/**
 * WHAT A TAB LOADED BEFORE THE RELEASE IS TOLD.
 *
 * During the rollout window — the migration applied, this frontend not yet
 * deployed — a browser tab that is still open calls the one-argument
 * approve_order_submission. That signature is kept alive precisely so it can
 * say this instead of answering "function not found", which nobody can act on.
 * It creates nothing.
 *
 * The code is mapped here because this bundle owns every sentence it renders,
 * and because a tab left open ACROSS the deploy would be running this code
 * against that function.
 */
export const CLIENT_UPDATE_REQUIRED_MESSAGE =
  'This page is out of date. Refresh it before confirming the Order — a salesperson, a confirm date, a due date and a lead source are now required.'

const SERVER_FAILURES: readonly { code: string; field: OrderConfirmationField | null; message: string }[] = [
  // Not about one field: the whole call is from a client that predates them.
  { code: 'ORDER_CONFIRMATION_CLIENT_UPDATE_REQUIRED', field: null, message: CLIENT_UPDATE_REQUIRED_MESSAGE },
  { code: 'ORDER_CONFIRMATION_SALESPERSON_REQUIRED',  field: 'salesperson',  message: ORDER_CONFIRMATION_MESSAGE.salesperson },
  { code: 'ORDER_CONFIRMATION_SALESPERSON_UNKNOWN',   field: 'salesperson',  message: 'That salesperson is no longer a BOE user. Choose another before confirming this Order.' },
  { code: 'ORDER_CONFIRMATION_CONFIRM_DATE_REQUIRED', field: 'confirm_date', message: ORDER_CONFIRMATION_MESSAGE.confirm_date },
  { code: 'ORDER_CONFIRMATION_DUE_DATE_REQUIRED',     field: 'due_date',     message: ORDER_CONFIRMATION_MESSAGE.due_date },
  { code: 'ORDER_CONFIRMATION_LEAD_SOURCE_REQUIRED',  field: 'lead_source',  message: ORDER_CONFIRMATION_MESSAGE.lead_source },
  { code: 'ORDER_CONFIRMATION_LEAD_SOURCE_INVALID',   field: 'lead_source',  message: 'That lead source is not one BOE records. Choose another before confirming this Order.' },
]

export type ConfirmationFailure = { field: OrderConfirmationField | null; message: string }

/**
 * A refusal that names one of the four, or null when the failure is about
 * something else entirely (payment, diagnostics, permission) and belongs to
 * the caller's own error handling.
 */
export function describeConfirmationFailure(error: unknown): ConfirmationFailure | null {
  const raw = typeof error === 'string'
    ? error
    : String((error as { message?: unknown } | null)?.message ?? '')
  const known = SERVER_FAILURES.find(entry => raw.includes(entry.code))
  return known ? { field: known.field, message: known.message } : null
}
