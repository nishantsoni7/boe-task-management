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
//   required later           nothing today. The BOE salesperson used to be
//                            listed here; since 2026-10-30 Submit names the
//                            person submitting when Sales chose nobody, so it
//                            is never missing when the Order is created. The
//                            lead source is required for submission.
//   optional                 billing percentage, payment terms, Client PO,
//                            Design Files and the order highlight. The
//                            salesperson is not listed: empty is not "skipped".
//
// A LATER item is never a submission blocker. It is listed so the person knows
// it is coming, and left out of the "proceed without these?" question, which is
// about things they could have filled in and chose not to.

import { readBillingPercentage } from './billingPercentage'
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

  // Empty since 2026-10-30: see "required later" above.
  const laterMissing: CompletionItem[] = []

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

// ── The Submit card's checklist (owner, 2026-10-30) ──────────────────────────
//
// Beside the payment, one line per part of the PI: what is done, what Submit
// still waits for, and what is optional. The SAME three lists as above, grouped
// by where each item is filled in — so the checklist, the sections' own "needed"
// marks and the Submit control can never disagree.

export type SubmitCheckState = 'ok' | 'need' | 'optional'

export type SubmitCheck = {
  key: 'client' | 'details' | 'products' | 'supporting' | 'advance'
  label: string
  state: SubmitCheckState
  text: string
  /** The first item a form can fix, for the line's "Add"; null when none can. */
  fix: CompletionItem | null
}

const CLIENT_WHERE: readonly CompletionWhere[] = ['client']
const DETAILS_WHERE: readonly CompletionWhere[] = ['internal', 'schedule', 'terms']
const PRODUCTS_WHERE: readonly CompletionWhere[] = ['products', 'workbook']
const SUPPORTING_WHERE: readonly CompletionWhere[] = ['documents', 'highlight']

const neededText = (items: readonly CompletionItem[]): string =>
  `${joinItemNames(items)} ${items.length === 1 ? 'is' : 'are'} needed`

const firstFixable = (items: readonly CompletionItem[]): CompletionItem | null =>
  items.find(item => !item.needsReimport) ?? null

export function buildSubmitChecks(input: {
  completion: Pick<PiCompletion, 'requiredMissing' | 'optionalMissing'>
  /** Workbook problems saved at parse time; only a corrected workbook clears them. */
  blockingCount: number
  /**
   * Where the advance stands, as the database decided it — or null while the
   * payment summary has not been read. Below the standard never blocks Submit:
   * the Submit sequence asks for the reason instead.
   */
  advance: { met: boolean; receivedPercent: string; standard: string | null } | null
}): SubmitCheck[] {
  const required = (where: readonly CompletionWhere[]) =>
    input.completion.requiredMissing.filter(item => where.includes(item.where))
  const checks: SubmitCheck[] = []

  const client = required(CLIENT_WHERE)
  checks.push(client.length === 0
    ? { key: 'client', label: 'Client', state: 'ok', text: 'Complete', fix: null }
    : { key: 'client', label: 'Client', state: 'need', text: neededText(client), fix: firstFixable(client) })

  const details = required(DETAILS_WHERE)
  checks.push(details.length === 0
    ? { key: 'details', label: 'Order details', state: 'ok', text: 'Complete', fix: null }
    : { key: 'details', label: 'Order details', state: 'need', text: neededText(details), fix: firstFixable(details) })

  // Drawn only when something is wrong: a clean product list is not news.
  const products = required(PRODUCTS_WHERE)
  if (input.blockingCount > 0 || products.length > 0) {
    checks.push({
      key: 'products',
      label: 'Products and workbook',
      state: 'need',
      text: input.blockingCount > 0 ? 'Fix the issues in the PI first' : neededText(products),
      fix: input.blockingCount > 0 ? null : firstFixable(products),
    })
  }

  const supporting = input.completion.optionalMissing.filter(item => SUPPORTING_WHERE.includes(item.where))
  checks.push(supporting.length === 0
    ? { key: 'supporting', label: 'Supporting details', state: 'ok', text: 'All added', fix: null }
    : { key: 'supporting', label: 'Supporting details', state: 'optional', text: 'Optional — you will be asked once when you submit', fix: null })

  if (input.advance) {
    const standard = input.advance.standard ?? 'the standard advance'
    checks.push(input.advance.met
      ? { key: 'advance', label: `Advance ${input.advance.receivedPercent}`, state: 'ok', text: `${standard} reached`, fix: null }
      : { key: 'advance', label: `Advance ${input.advance.receivedPercent}`, state: 'need', text: `Below ${standard} — give the reason when you submit`, fix: null })
  }
  return checks
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

// ── The facts the area shows for the client ─────────────────────────────────
//
// Read straight off the row, in the order the form asks for them. The labels for
// the required ones are the readiness list's own, so the checklist and the row
// beside it always name a field the same way.
//
// The salesperson contact number and the PI's own terms (creation date, workbook
// salesperson, commercial terms) are not drawn here: they are still stored,
// still required to submit, and still edited from Edit PI and the existing
// client and terms editors. The Submit control names any of them that is missing.

export type CompletionFact = {
  key: string
  label: string
  need: CompletionNeed
  /** The value as a reader reads it, or null when there is none. */
  value: string | null
  group: 'client'
}

export type CompletionFactsRow = {
  client_name?: string | null
  client_city?: string | null
  bill_to_phone?: string | null
  billing_address?: string | null
  shipping_address?: string | null
}

const text = (value: unknown): string | null => {
  const t = value === null || value === undefined ? '' : String(value).trim()
  return t === '' ? null : t
}

export function buildCompletionFacts(row: CompletionFactsRow): CompletionFact[] {
  return [
    { key: 'client_name', label: 'Client name', need: 'submission', value: text(row.client_name), group: 'client' },
    { key: 'client_city', label: 'Client city', need: 'submission', value: text(row.client_city), group: 'client' },
    { key: 'bill_to_phone', label: 'Client phone', need: 'optional', value: text(row.bill_to_phone), group: 'client' },
    { key: 'billing_address', label: 'Billing address', need: 'optional', value: text(row.billing_address), group: 'client' },
    { key: 'shipping_address', label: 'Shipping address', need: 'optional', value: text(row.shipping_address), group: 'client' },
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
