// ── What a PI Draft still needs, in one list ────────────────────────────────
//
// The Complete PI details area and the Submit sequence both ask the same three
// questions, and this is the one place that answers them:
//
//   1  What blocks Submit for approval?               requiredMissing
//   2  What is only needed later, to create the Order? laterMissing
//   3  What is optional and still empty?               optionalMissing
//
// IT INVENTS NO RULE. Every classification is one the code and database already
// hold, and this file only assembles them:
//
//   required for submission  piReadiness('submission') plus the internal-order
//                            details the database also refuses a submission
//                            without (withOrderDetailsRequirements): the client
//                            name and city, the salesperson and their number,
//                            the creation date, fabric responsibility, the
//                            commercial terms, the two order dates and the
//                            middleman answer — and the workbook and product
//                            lines, which only a re-import can fix.
//   required later           the salesperson and lead source, which
//                            approve_order_submission asks for when the Order is
//                            created (ORDER_DETAILS_FIELDS, need 'approval').
//   optional                 billing percentage, payment terms, Client PO,
//                            Design Files and the order highlight.
//
// A LATER item is never a submission blocker. It is listed so the person knows
// it is coming, and left out of the "proceed without these?" question, which is
// about things they could have filled in and chose not to.

import { readBillingPercentage } from './billingPercentage'
import { WORKBOOK_SALESPERSON_LABEL } from './orderConfirmation'
import { CATEGORY_LABEL, type DocumentCategory } from './orderDocumentSubmissions'
import { HIGHLIGHT_REMARK_TITLE } from './highlightRemark'
import { orderDetailsFieldOf, ORDER_DETAILS_FIELD, type OrderDetailsFieldKey, type OrderDetailsRow } from './salesOrderDetails'
import type { PiReadiness, PiRequirement } from './piReadiness'

export type CompletionNeed = 'submission' | 'later' | 'optional'

/** The three labels the area shows beside every field. */
export const COMPLETION_NEED_LABEL: Record<CompletionNeed, string> = {
  submission: 'Required for submission',
  later: 'Required later to create the Order',
  optional: 'Optional',
}

/** Where an item is filled in, so a checklist entry can take the person there. */
export type CompletionWhere = PiRequirement['section'] | 'documents' | 'highlight'

export type CompletionItem = {
  key: string
  label: string
  need: CompletionNeed
  where: CompletionWhere
  /** For `where: 'internal'`: the field to focus. */
  field?: OrderDetailsFieldKey
  /** Only a corrected workbook can supply it — no form is offered. */
  needsReimport?: boolean
}

export type PiCompletion = {
  requiredMissing: CompletionItem[]
  laterMissing: CompletionItem[]
  optionalMissing: CompletionItem[]
  /** No required item is missing. Says nothing about permission or the server. */
  readyToSubmit: boolean
}

const blank = (value: unknown): boolean => value === null || value === undefined || String(value).trim() === ''

export function buildPiCompletion(input: {
  /** withOrderDetailsRequirements(piReadiness('submission', …), row) — the submission blockers. */
  readiness: PiReadiness
  /** The PI row with the salesperson and lead source laid over it. */
  details: OrderDetailsRow
  /** False until 20270211000000 is applied: the two later fields cannot be asked for yet. */
  salesDetailsAvailable: boolean
  /** Categories with no file attached. */
  supportingMissing: readonly DocumentCategory[]
  /** The order highlight; `available` is false when it could not be read. */
  highlight: { available: boolean; remark: string | null }
}): PiCompletion {
  const requiredMissing: CompletionItem[] = input.readiness.missing.map(requirement => {
    const field = orderDetailsFieldOf(requirement.key) ?? undefined
    return {
      key: requirement.key,
      label: requirement.label,
      need: 'submission' as const,
      where: requirement.section,
      ...(field ? { field } : {}),
      ...(requirement.needsReimport ? { needsReimport: true } : {}),
    }
  })

  const laterMissing: CompletionItem[] = []
  if (input.salesDetailsAvailable) {
    if (blank(input.details.salesperson_id)) {
      laterMissing.push({ key: 'salesperson_id', label: ORDER_DETAILS_FIELD.salesperson_id.label, need: 'later', where: 'internal', field: 'salesperson_id' })
    }
    if (blank(input.details.lead_source)) {
      laterMissing.push({ key: 'lead_source', label: ORDER_DETAILS_FIELD.lead_source.label, need: 'later', where: 'internal', field: 'lead_source' })
    }
  }

  const optionalMissing: CompletionItem[] = []
  if (readBillingPercentage(input.details.billing_percentage ?? null) === null) {
    optionalMissing.push({ key: 'billing_percentage', label: ORDER_DETAILS_FIELD.billing_percentage.label, need: 'optional', where: 'internal', field: 'billing_percentage' })
  }
  if (blank(input.details.payment_terms)) {
    optionalMissing.push({ key: 'payment_terms', label: ORDER_DETAILS_FIELD.payment_terms.label, need: 'optional', where: 'internal', field: 'payment_terms' })
  }
  for (const category of input.supportingMissing) {
    optionalMissing.push({ key: `documents:${category}`, label: CATEGORY_LABEL[category], need: 'optional', where: 'documents' })
  }
  if (input.highlight.available && blank(input.highlight.remark)) {
    optionalMissing.push({ key: 'order_highlight', label: HIGHLIGHT_REMARK_TITLE, need: 'optional', where: 'highlight' })
  }

  return { requiredMissing, laterMissing, optionalMissing, readyToSubmit: requiredMissing.length === 0 }
}

/** "Billing percentage, Payment terms and Client PO" — the names the question lists. */
export function joinItemNames(items: readonly { label: string }[]): string {
  const names = items.map(item => item.label)
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The question the Submit sequence asks when optional items are still empty. */
export const PROCEED_WITHOUT_QUESTION = 'Would you like to proceed without these details?'
export const PROCEED_WITHOUT_TITLE = 'Proceed without these details?'
export const PROCEED_GO_BACK_LABEL = 'Go back and fill them'
export const PROCEED_CONTINUE_LABEL = 'Continue'

/** The last thing said before the PI leaves the employee's hands. */
export const SUBMIT_FINAL_WARNING =
  'After submission, you cannot edit this PI while it is with management. You can request a change from management.'

// ── The Submit sequence ─────────────────────────────────────────────────────
//
//   1  optional  the names of what is still empty, and one question — skipped
//                when nothing optional is missing
//   2  advance   the existing exception request (reason and remark) — skipped
//                unless the PI is below the advance requirement, or the position
//                could not be read, in which case it fails closed
//   3  final     the read-only warning, then Submit — never skipped
//
// Kept as data so the order is one tested answer and not three conditions
// scattered through a dialog.

export type SubmitStage = 'optional' | 'advance' | 'final'

const STAGE_ORDER: readonly SubmitStage[] = ['optional', 'advance', 'final']

export function submitStages(input: { optionalCount: number; meetsStandard: boolean | null }): SubmitStage[] {
  const stages: SubmitStage[] = []
  if (input.optionalCount > 0) stages.push('optional')
  // null is "could not be read": the advance step is where that is said and Continue stays off.
  if (input.meetsStandard !== true) stages.push('advance')
  stages.push('final')
  return stages
}

/** The stage after `current` — by canonical order, so a stage that stopped applying is stepped over. */
export function stageAfter(stages: readonly SubmitStage[], current: SubmitStage): SubmitStage {
  const at = STAGE_ORDER.indexOf(current)
  return stages.find(stage => STAGE_ORDER.indexOf(stage) > at) ?? 'final'
}

// ── The facts the area shows for the client and the PI's own terms ──────────
//
// Read straight off the row, in the order the form asks for them. The labels for
// the required ones are the readiness list's own, so the checklist and the row
// beside it always name a field the same way.

export type CompletionFact = {
  key: string
  label: string
  need: CompletionNeed
  /** The value as a reader reads it, or null when there is none. */
  value: string | null
  group: 'client' | 'terms'
}

export type CompletionFactsRow = {
  client_name?: string | null
  client_city?: string | null
  contact_number?: string | null
  bill_to_phone?: string | null
  billing_address?: string | null
  shipping_address?: string | null
  creation_date?: string | null
  source_created_by?: string | null
  commercial_terms_note?: string | null
}

const text = (value: unknown): string | null => {
  const t = value === null || value === undefined ? '' : String(value).trim()
  return t === '' ? null : t
}

export function buildCompletionFacts(row: CompletionFactsRow, formatDay: (iso: string | null | undefined) => string | null): CompletionFact[] {
  return [
    { key: 'client_name', label: 'Client name', need: 'submission', value: text(row.client_name), group: 'client' },
    { key: 'client_city', label: 'Client city', need: 'submission', value: text(row.client_city), group: 'client' },
    { key: 'contact_number', label: 'Salesperson contact number', need: 'submission', value: text(row.contact_number), group: 'client' },
    { key: 'bill_to_phone', label: 'Client phone', need: 'optional', value: text(row.bill_to_phone), group: 'client' },
    { key: 'billing_address', label: 'Billing address', need: 'optional', value: text(row.billing_address), group: 'client' },
    { key: 'shipping_address', label: 'Shipping address', need: 'optional', value: text(row.shipping_address), group: 'client' },
    { key: 'creation_date', label: 'Date of creation', need: 'submission', value: formatDay(row.creation_date ?? null), group: 'terms' },
    { key: 'source_created_by', label: WORKBOOK_SALESPERSON_LABEL, need: 'submission', value: text(row.source_created_by), group: 'terms' },
    { key: 'commercial_terms_note', label: 'Commercial terms', need: 'submission', value: text(row.commercial_terms_note), group: 'terms' },
  ]
}

// ── The locked state, in words ──────────────────────────────────────────────

export const PI_LOCKED_TITLE = 'Submitted — this PI is locked'
/** What this viewer is doing on a PI that is with management — every fact from an answer the page already holds. */
export type LockedViewer = {
  /** created_by or submitted_by. */
  ownsSubmission: boolean
  /** can_admin_edit_order_submission: an active admin may amend at any stage, with a reason. */
  canAdminAmend: boolean
  /** can_edit_order_submission: the owner rule. False for everybody once a PI is submitted. */
  canEdit: boolean
  /** orders.approve_order: may send it back, reject it, or approve it. */
  canReview: boolean
  /** The record-a-payment rule the payment card already uses. */
  canAddPayment: boolean
}

/**
 * THE LOCK NOTICE'S SECOND LINE, worded for what THIS viewer can actually do.
 *
 * It only DESCRIBES: each clause is the page's own answer to the question the
 * database re-asks on every write, so the sentence cannot promise a right the
 * screen is not also offering — or deny one it is.
 *
 *   owner            cannot edit; may request a change from management
 *   active admin     may still amend, from Edit PI, with a reason
 *   management       may approve, send back or reject, and may not edit
 *   anybody else     reads it
 *
 * Adding a payment is not an edit of the PI, so it is said separately, and only
 * to somebody who may do it.
 */
export function describeLockedNotice(viewer: LockedViewer): string {
  const parts: string[] = []
  if (viewer.canAdminAmend) {
    parts.push('It is with management for review. As an administrator you can still amend it from Edit PI, with a reason.')
  } else if (viewer.ownsSubmission && !viewer.canEdit) {
    parts.push(PI_LOCKED_OWNER_SENTENCE)
  } else {
    parts.push('It is with management for review, and you cannot edit it.')
  }
  if (viewer.canReview) {
    parts.push('You can approve it, send it back for changes, or reject it.')
  } else if (!viewer.ownsSubmission && !viewer.canAdminAmend) {
    parts.push('You can read it here.')
  }
  if (!viewer.canAdminAmend && !viewer.canReview && !viewer.ownsSubmission) {
    // nothing more to add
  } else if (!viewer.canAdminAmend && !viewer.ownsSubmission) {
    parts.push('It can be edited again only if it is sent back for changes.')
  }
  if (viewer.canAddPayment) parts.push('You can still add payments; that does not edit the PI.')
  return parts.join(' ')
}

export const PI_LOCKED_OWNER_SENTENCE =
  'You cannot edit this PI while it is with management. You can request a change from management.'
