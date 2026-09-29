// ── Internal order details: what Sales owns about a PI, in one place ─────────
//
// Before this, the same facts were asked for in four places: the Internal
// details editor (dates, middleman), Edit PI (dates, fabric, billing), the
// Submit for Approval dialog (the dates again) and the Create Confirmed Order
// dialog (salesperson, dates and lead source, typed by management). This module
// is the one description of them for the saved PI Draft's "Internal order
// details" section, the Submit review and the approval review.
//
// IT INVENTS NO FIELD AND NO RULE. Every value is an existing column, saved by
// the RPC that already owns it:
//
//   order_confirmation_date, due_date,   save_order_submission_internal_details
//   middleman commission                 (20270122000000; draft save, p_confirm false)
//   fabric_responsibility                update_order_submission_pi_terms (20261225000000)
//   billing_terms                        update_order_submission_schedule_terms (20270122000000)
//   billing_percentage                   set_order_submission_billing_percentage (20260927000000)
//   salesperson_id, lead_source          set_order_submission_sales_details (20270211000000)
//
// and every requirement is the one the database already enforces: the dates
// (with the due date on or after the confirmation date), fabric responsibility
// and the middleman answer are needed to SUBMIT; the salesperson and lead source
// are needed to CREATE THE ORDER; billing is optional. Nothing here makes an
// optional field mandatory.

import {
  BILLING_MAX,
  BILLING_MIN,
  formatBillingPercentage,
  parseBillingPercentage,
  readBillingPercentage,
} from './billingPercentage'
import { ORDER_LEAD_SOURCES, isOrderLeadSource, leadSourceLabel, SALESPERSON_LABEL } from './orderConfirmation'
import {
  FABRIC_RESPONSIBILITY_LABEL,
  FABRIC_RESPONSIBILITY_UNANSWERED,
  fabricResponsibilityLabel,
  isFabricResponsibility,
} from './piTerms'
import { summarizePiReadiness, type PiReadiness, type PiRequirement } from './piReadiness'
import {
  describeMiddleman,
  formatIsoDay,
  internalDetailsForm,
  internalDetailsPayload,
  internalDetailsShapeErrors,
  middlemanAnswerMissing,
  MIDDLEMAN_QUESTION,
  SUBMISSION_DATE_LABEL,
  type PiInternalDetailsForm,
  type PiInternalDetailsRow,
} from './piInternalDetails'

export const ORDER_DETAILS_TITLE = 'Internal order details'
export const ORDER_DETAILS_ANCHOR = 'pi-internal-order-details'
/**
 * What the section is, honestly, checked against the rendered client PDF
 * (Confirmed Order and PI versions, one builder). Of the fields here, only
 * fabric responsibility is printed, as one sentence. Billing percentage and its
 * value stopped being printed in #248; the dates, lead source, billing terms and
 * middleman commission never were. The PDF DOES print a Salesperson and a
 * Salesperson contact — but from the workbook (source_created_by,
 * contact_number), never the salesperson_id chosen here, which the PDF does
 * not even read. The note says so, so nobody expects a change here to reach it.
 */
export const ORDER_DETAILS_NOTE =
  'For BOE. Kept off the client workbook. Of these fields, only fabric responsibility appears on the generated client PDF, as one sentence. The PDF also shows a salesperson and contact number, but those are the ones the workbook states, not the Salesperson chosen here.'

/** How much a field is needed, in the words the section shows beside it. */
export type OrderDetailsNeed = 'submission' | 'approval' | 'optional' | 'conditional'

export const ORDER_DETAILS_NEED_LABEL: Record<OrderDetailsNeed, string> = {
  submission: 'Required for submission',
  approval: 'Required later to create the Order',
  optional: 'Optional',
  conditional: 'Required if Yes',
}

export type OrderDetailsFieldKey =
  | 'order_confirmation_date' | 'due_date'
  | 'salesperson_id' | 'lead_source'
  | 'billing_percentage' | 'billing_terms'
  | 'fabric_responsibility'
  | 'middleman_commission' | 'middleman_structure'

export type OrderDetailsField = { key: OrderDetailsFieldKey; label: string; need: OrderDetailsNeed; hint?: string }

/** Every field, in the order the section shows them. */
export const ORDER_DETAILS_FIELDS: readonly OrderDetailsField[] = [
  { key: 'order_confirmation_date', label: SUBMISSION_DATE_LABEL.order_confirmation_date, need: 'submission' },
  { key: 'due_date',                label: SUBMISSION_DATE_LABEL.due_date,                need: 'submission', hint: 'On or after the order confirmation date.' },
  { key: 'salesperson_id',          label: SALESPERSON_LABEL,                             need: 'approval', hint: 'Management sees it when creating the Order and may change it. Not printed on the client PDF, which shows the salesperson the workbook names.' },
  { key: 'lead_source',             label: 'Lead source',                                 need: 'approval' },
  { key: 'billing_percentage',      label: 'Billing percentage',                          need: 'optional', hint: `From ${BILLING_MIN}% to ${BILLING_MAX}%. Internal; not printed on the client PDF.` },
  { key: 'billing_terms',           label: 'Billing terms',                               need: 'optional' },
  { key: 'fabric_responsibility',   label: FABRIC_RESPONSIBILITY_LABEL,                   need: 'submission', hint: 'Printed on the client PDF as one sentence.' },
  { key: 'middleman_commission',    label: MIDDLEMAN_QUESTION,                            need: 'submission' },
  { key: 'middleman_structure',     label: 'Who receives it, and the amount or percentage', need: 'conditional' },
]

export const ORDER_DETAILS_FIELD: Record<OrderDetailsFieldKey, OrderDetailsField> =
  Object.fromEntries(ORDER_DETAILS_FIELDS.map(f => [f.key, f])) as Record<OrderDetailsFieldKey, OrderDetailsField>

export const BILLING_TERMS_MAX = 500

/** Said in the Submit review when the dates are missing or out of order. */
export const SUBMISSION_DETAILS_INCOMPLETE =
  'Add both order dates (the due date on or after the confirmation date) in Internal order details on the PI, then submit.'

/** The PI row as this section reads it. Every column already exists. */
export type OrderDetailsRow = PiInternalDetailsRow & {
  salesperson_id?: string | null
  lead_source?: string | null
  billing_percentage?: number | string | null
  billing_terms?: string | null
  fabric_responsibility?: string | null
  source_created_by?: string | null
}

/**
 * The two 20270211000000 columns, read on their own so a database without them
 * answers "not available" instead of failing the PI's main read.
 */
export const SALES_DETAILS_COLUMNS = 'salesperson_id, lead_source'

export type SalesDetails = { available: boolean; salesperson_id: string | null; lead_source: string | null }

export const SALES_DETAILS_UNAVAILABLE: SalesDetails = { available: false, salesperson_id: null, lead_source: null }

/** A failed read (null) is "not available"; a row is the two values, blanks as null. */
export function readSalesDetails(data: unknown): SalesDetails {
  if (!data || typeof data !== 'object') return SALES_DETAILS_UNAVAILABLE
  const d = data as Record<string, unknown>
  const id = typeof d.salesperson_id === 'string' && d.salesperson_id.trim() ? d.salesperson_id : null
  const lead = typeof d.lead_source === 'string' && d.lead_source.trim() ? d.lead_source : null
  return { available: true, salesperson_id: id, lead_source: lead }
}

export type OrderDetailsForm = PiInternalDetailsForm & {
  salesperson_id: string
  lead_source: string
  billing_percentage: string
  billing_terms: string
  fabric_responsibility: string
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const blankToNull = (v: string): string | null => (v.trim() === '' ? null : v.trim())

/** The form, opened on what the record holds. */
export function orderDetailsForm(row: OrderDetailsRow): OrderDetailsForm {
  const billing = readBillingPercentage(row.billing_percentage ?? null)
  return {
    ...internalDetailsForm(row),
    salesperson_id: text(row.salesperson_id),
    lead_source: isOrderLeadSource(row.lead_source) ? row.lead_source : '',
    billing_percentage: billing === null ? '' : String(billing),
    billing_terms: text(row.billing_terms),
    fabric_responsibility: isFabricResponsibility(row.fabric_responsibility) ? row.fabric_responsibility : '',
  }
}

/**
 * Problems that stop even a DRAFT save — the shapes an RPC would refuse. A
 * blank field is never one: saving a private draft with details missing is
 * allowed, and completeness is the submission's question.
 */
export function orderDetailsErrors(
  form: OrderDetailsForm,
  grandTotal: number | null,
): Partial<Record<keyof OrderDetailsForm, string>> {
  const errors: Partial<Record<keyof OrderDetailsForm, string>> = { ...internalDetailsShapeErrors(form, grandTotal) }
  if (form.billing_percentage.trim() !== '') {
    const parsed = parseBillingPercentage(form.billing_percentage)
    if (!parsed.ok) errors.billing_percentage = parsed.message
  }
  if (form.billing_terms.trim().length > BILLING_TERMS_MAX) errors.billing_terms = `At most ${BILLING_TERMS_MAX} characters.`
  if (form.lead_source && !isOrderLeadSource(form.lead_source)) errors.lead_source = 'Choose one of the listed lead sources.'
  if (form.fabric_responsibility && !isFabricResponsibility(form.fabric_responsibility)) {
    errors.fabric_responsibility = 'Choose one of the listed answers.'
  }
  return errors
}

// ── Saving: the existing doors, only the ones whose values changed ────────────

export type OrderDetailsRpc =
  | 'set_order_submission_sales_details'
  | 'update_order_submission_pi_terms'
  | 'update_order_submission_schedule_terms'
  | 'set_order_submission_billing_percentage'
  | 'save_order_submission_internal_details'

export type OrderDetailsSaveStep = {
  rpc: OrderDetailsRpc
  /** What the reader is told saved, or did not. */
  label: string
  /** Every argument but p_submission_id and p_expected_version. */
  args: Record<string, unknown>
  /** Whether the RPC takes p_expected_version. */
  versioned: boolean
}

/**
 * THE WRITES A SAVE MAKES, IN ORDER — one per owning RPC, and only where a value
 * changed, so an unchanged group is never rewritten (and a confirmed internal
 * details stamp is not cleared by a save that did not touch it). The internal
 * details go last: a draft save that changes them clears the confirmation, which
 * Submit for Approval then asks for again.
 */
export function orderDetailsSavePlan(row: OrderDetailsRow, form: OrderDetailsForm): OrderDetailsSaveStep[] {
  const before = orderDetailsForm(row)
  const steps: OrderDetailsSaveStep[] = []

  if (form.salesperson_id !== before.salesperson_id || form.lead_source !== before.lead_source) {
    steps.push({
      rpc: 'set_order_submission_sales_details', label: 'Salesperson and lead source', versioned: true,
      args: { p_salesperson_id: blankToNull(form.salesperson_id), p_lead_source: blankToNull(form.lead_source) },
    })
  }
  if (form.fabric_responsibility !== before.fabric_responsibility) {
    steps.push({
      rpc: 'update_order_submission_pi_terms', label: FABRIC_RESPONSIBILITY_LABEL, versioned: true,
      args: { p_fields: { fabric_responsibility: blankToNull(form.fabric_responsibility) }, p_reason: null },
    })
  }
  if (blankToNull(form.billing_terms) !== blankToNull(before.billing_terms)) {
    steps.push({
      rpc: 'update_order_submission_schedule_terms', label: 'Billing terms', versioned: true,
      args: { p_fields: { billing_terms: blankToNull(form.billing_terms) }, p_reason: null },
    })
  }
  const nextBilling = form.billing_percentage.trim() === '' ? null : Number(form.billing_percentage.trim().replace(/%$/, ''))
  const prevBilling = before.billing_percentage.trim() === '' ? null : Number(before.billing_percentage)
  if (nextBilling !== prevBilling) {
    steps.push({
      rpc: 'set_order_submission_billing_percentage', label: 'Billing percentage', versioned: false,
      args: { p_percentage: nextBilling, p_reason: null },
    })
  }
  const nextInternal = internalDetailsPayload(form)
  if (JSON.stringify(nextInternal) !== JSON.stringify(internalDetailsPayload(before))) {
    steps.push({
      rpc: 'save_order_submission_internal_details', label: 'Order dates and middleman commission', versioned: true,
      args: { p_details: nextInternal, p_confirm: false },
    })
  }
  return steps
}

export type OrderDetailsSaveResult =
  | { ok: true; saved: string[]; version: number | null }
  /**
   * A step was refused. `saved` names what ALREADY committed (each step is its
   * own transaction), `failed` the one refused, `pending` what was not tried.
   */
  | { ok: false; saved: string[]; failed: string; pending: string[]; message: string; version: number | null }

/**
 * RUN A SAVE PLAN, one RPC at a time, stopping at the first refusal.
 *
 * Each step carries the row version the previous one handed back (or, for the
 * one RPC that returns none, the version read after it), so the chain never
 * trips its own staleness check. The steps are separate transactions and
 * nothing is rolled back: a refusal part-way leaves the earlier groups saved,
 * and the result says exactly which. A RETRY is safe by construction — the
 * caller re-reads the record and recomputes orderDetailsSavePlan, which then
 * holds only the groups that still differ.
 */
export async function runOrderDetailsSave(input: {
  plan: readonly OrderDetailsSaveStep[]
  version: number | null
  call: (rpc: OrderDetailsRpc, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>
  readVersion: () => Promise<number | null>
}): Promise<OrderDetailsSaveResult> {
  const saved: string[] = []
  let version = input.version
  for (const [index, step] of input.plan.entries()) {
    const args: Record<string, unknown> = { ...step.args }
    if (step.versioned) args.p_expected_version = version
    let error: { message?: string } | null = null
    let data: unknown = null
    try {
      ({ data, error } = await input.call(step.rpc, args))
    } catch (thrown) {
      error = { message: String((thrown as { message?: string })?.message ?? '') }
    }
    if (error) {
      return {
        ok: false, saved, failed: step.label, pending: input.plan.slice(index + 1).map(s => s.label),
        message: String(error.message ?? '').replace(/^[A-Z_]+:\s*/, '') || 'It could not be saved.',
        version,
      }
    }
    saved.push(step.label)
    const next = (data as { row_version?: unknown } | null)?.row_version
    version = typeof next === 'number' ? next : await input.readVersion()
  }
  return { ok: true, saved, version }
}

/** What the reader is told after a refusal part-way through a save. */
export function orderDetailsSaveFailureText(result: Extract<OrderDetailsSaveResult, { ok: false }>): string {
  const said = /[.!?]$/.test(result.message) ? result.message : `${result.message}.`
  const parts = [`${result.failed} was not saved: ${said}`]
  if (result.saved.length) parts.push(`Already saved: ${result.saved.join(', ')}.`)
  if (result.pending.length) parts.push(`Not saved yet: ${result.pending.join(', ')}.`)
  parts.push('Your remaining edits are still in the form — correct them if needed and press Save details again; only what is still unsaved is sent.')
  return parts.join(' ')
}

// ── What is still missing, for the readiness checklist ───────────────────────

export type OrderDetailsGap = { key: OrderDetailsFieldKey; label: string }

/**
 * What this section still needs before the PI can be SUBMITTED — the database's
 * own gates, and nothing more. The salesperson and lead source are not here:
 * they are needed to create the Order, not to submit the PI.
 */
export function orderDetailsSubmissionGaps(row: OrderDetailsRow): OrderDetailsGap[] {
  const gaps: OrderDetailsGap[] = []
  const confirm = text(row.order_confirmation_date).slice(0, 10)
  const due = text(row.due_date).slice(0, 10)
  if (!confirm) gaps.push({ key: 'order_confirmation_date', label: SUBMISSION_DATE_LABEL.order_confirmation_date })
  if (!due) gaps.push({ key: 'due_date', label: SUBMISSION_DATE_LABEL.due_date })
  else if (confirm && due < confirm) gaps.push({ key: 'due_date', label: `${SUBMISSION_DATE_LABEL.due_date} on or after the confirmation date` })
  if (!isFabricResponsibility(row.fabric_responsibility)) gaps.push({ key: 'fabric_responsibility', label: FABRIC_RESPONSIBILITY_LABEL })
  const middleman = middlemanAnswerMissing(row)
  if (middleman) {
    gaps.push(middleman.includes(MIDDLEMAN_QUESTION)
      ? { key: 'middleman_commission', label: 'Middleman commission answer' }
      : { key: 'middleman_structure', label: 'Middleman commission details' })
  }
  return gaps
}

/** Each gap is keyed `order_details:<field>` so the page knows which field to focus. */
export const ORDER_DETAILS_REQUIREMENT_PREFIX = 'order_details:'

export function orderDetailsFieldOf(requirementKey: string): OrderDetailsFieldKey | null {
  if (!requirementKey.startsWith(ORDER_DETAILS_REQUIREMENT_PREFIX)) return null
  const key = requirementKey.slice(ORDER_DETAILS_REQUIREMENT_PREFIX.length) as OrderDetailsFieldKey
  return key in ORDER_DETAILS_FIELD ? key : null
}

/**
 * THE OWNER'S "READY FOR MANAGEMENT?" CHECKLIST, with this section's gaps in it.
 *
 * The database refuses a submission without both dates (in order), fabric
 * responsibility and the middleman answer (20261225000000, 20270123000000), so
 * the checklist names each one and points it at its field here. Fabric
 * responsibility comes from the shared piReadiness() already; it is re-pointed
 * rather than listed twice. DISPLAY ONLY: piReadiness(), which the payment
 * surface also reads, is not changed. Past draft/returned, nothing is added.
 */
export function withOrderDetailsRequirements(readiness: PiReadiness, row: OrderDetailsRow): PiReadiness {
  const open = !row.status || row.status === 'draft' || row.status === 'needs_changes'
  if (!open) return readiness
  const gaps = orderDetailsSubmissionGaps(row)
  const shared = readiness.missing.filter(m => m.key !== 'fabric_responsibility')
  const ours: PiRequirement[] = gaps.map(gap => ({
    key: `${ORDER_DETAILS_REQUIREMENT_PREFIX}${gap.key}`,
    label: gap.label,
    section: 'internal',
  }))
  const missing = [...shared, ...ours]
  if (missing.length === 0) return readiness.ready ? readiness : { ready: true, missing, summary: null }
  return { ready: false, missing, summary: summarizePiReadiness('submission', missing) }
}

// ── The review, for the Submit and approval dialogs ──────────────────────────

export type OrderDetailsReviewRow = {
  key: OrderDetailsFieldKey
  label: string
  /** The value as a reader reads it, or null when there is none. */
  value: string | null
  need: OrderDetailsNeed
}

/** The salesperson's name for a stored id, from the people the page loaded. */
export function salespersonName(
  id: string | null | undefined,
  people: readonly { id: string; name: string }[],
): string | null {
  if (!id) return null
  return people.find(p => p.id === id)?.name ?? null
}

/**
 * The section as a compact review: one row per fact, the value in words.
 * `people` resolves the salesperson id to a name; an id nobody in the list has
 * reads as "Saved (not in the list)" rather than as a blank or a guess.
 */
export function orderDetailsReview(
  row: OrderDetailsRow,
  people: readonly { id: string; name: string }[],
): OrderDetailsReviewRow[] {
  const salesperson = row.salesperson_id
    ? salespersonName(row.salesperson_id, people) ?? 'Saved (not in the list)'
    : null
  const billing = readBillingPercentage(row.billing_percentage ?? null)
  const middleman = describeMiddleman(row)
  return [
    { key: 'order_confirmation_date', label: ORDER_DETAILS_FIELD.order_confirmation_date.label, value: formatIsoDay(row.order_confirmation_date), need: 'submission' },
    { key: 'due_date',                label: ORDER_DETAILS_FIELD.due_date.label,                value: formatIsoDay(row.due_date),                need: 'submission' },
    { key: 'salesperson_id',          label: SALESPERSON_LABEL,                                 value: salesperson,                                need: 'approval' },
    { key: 'lead_source',             label: 'Lead source',                                     value: leadSourceLabel(row.lead_source),           need: 'approval' },
    { key: 'billing_percentage',      label: 'Billing percentage',                              value: billing === null ? null : formatBillingPercentage(billing), need: 'optional' },
    { key: 'billing_terms',           label: 'Billing terms',                                   value: blankToNull(text(row.billing_terms)),        need: 'optional' },
    { key: 'fabric_responsibility',   label: FABRIC_RESPONSIBILITY_LABEL,                       value: fabricResponsibilityLabel(row.fabric_responsibility), need: 'submission' },
    { key: 'middleman_commission',    label: 'Middleman commission',                            value: middleman === 'Not answered' ? null : middleman, need: 'submission' },
  ]
}

/** What an empty value reads as, by how much it is needed. */
export function orderDetailsAbsent(need: OrderDetailsNeed, key?: OrderDetailsFieldKey): string {
  if (key === 'fabric_responsibility') return FABRIC_RESPONSIBILITY_UNANSWERED
  if (need === 'optional') return 'Not given'
  return 'Not added yet'
}

export const LEAD_SOURCE_OPTIONS = ORDER_LEAD_SOURCES
