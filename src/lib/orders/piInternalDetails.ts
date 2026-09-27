
/**
 * A PI'S INTERNAL DETAILS (20270122000000) — the confirmation and due dates
 * Sales confirms in the app, and the answer to "Is there a middleman
 * commission?".
 *
 * INTERNAL means exactly that: none of these is printed on a client-facing PI,
 * PDF, download or message. The client-facing surfaces read their own column
 * lists (see src/lib/orders/confirmedPdf.ts and orderPiHandoff.ts), and
 * piInternalDetails.test.ts pins that they name none of these columns.
 *
 * WHAT THIS MODULE IS. The screen's half of save_order_submission_internal_details()
 * and order_submission_internal_details_problem(): the same rules, in the same
 * order, so the form can say everything that is missing before the database
 * refuses. It is NOT the enforcement — the RPC and (from 20270123000000) the
 * submission trigger re-derive every rule under a row lock.
 */

export type MiddlemanAnswer = 'yes' | 'no'
export type CommissionBasis = 'amount' | 'percent'
export type CommissionPercentOf =
  | 'gross_product_amount'
  | 'subtotal_after_discount'
  | 'total_before_gst'
  | 'grand_total'

/** The order_submissions columns, as PI_DRAFT_DETAIL_COLUMNS reads them. No
 *  commission column is among them: that row is readable by every Order viewer. */
export const PI_INTERNAL_DETAIL_COLUMNS = [
  'workbook_order_confirmation_date', 'workbook_due_date',
  'internal_details_confirmed_at', 'internal_details_confirmed_by',
] as const

/**
 * THE COMMISSION HAS ITS OWN TABLE (20270122000000 §1b), readable only by the
 * PI's salesperson/submitter, its assigned reviewer, an active admin or a
 * holder of orders.view_pi_commission — can_read_order_submission_commission().
 * RLS returns no row to anybody else, which is indistinguishable from "not yet
 * answered", so the page asks that function too and shows "Restricted".
 * The page names both literally, so its table and RPC allow-lists see them.
 */
export const PI_COMMISSION_COLUMNS = [
  'middleman_commission', 'middleman_recipient', 'middleman_commission_basis',
  'middleman_commission_amount', 'middleman_commission_percent', 'middleman_commission_percent_of',
].join(', ')

export const COMMISSION_RESTRICTED_TEXT =
  'Restricted — visible to the salesperson, the assigned reviewer and people allowed in Control Center'

type CommissionFields = Pick<PiInternalDetailsRow,
  | 'middleman_commission' | 'middleman_recipient' | 'middleman_commission_basis'
  | 'middleman_commission_amount' | 'middleman_commission_percent' | 'middleman_commission_percent_of'>

/**
 * The PI row with its commission laid over it, as the card and editor read it.
 * FAILS CLOSED: a reader check that errored, or said no, is "restricted", and
 * no commission value is carried even if one somehow arrived.
 */
export function withCommission<T extends object>(
  row: T,
  commission: CommissionFields | null | undefined,
  readable: boolean,
): T & PiInternalDetailsRow {
  const blank: CommissionFields = {
    middleman_commission: null, middleman_recipient: null, middleman_commission_basis: null,
    middleman_commission_amount: null, middleman_commission_percent: null, middleman_commission_percent_of: null,
  }
  if (!readable) return { ...row, ...blank, commission_restricted: true }
  return { ...row, ...blank, ...(commission ?? {}), commission_restricted: false }
}

export type PiInternalDetailsRow = {
  order_confirmation_date?: string | null
  due_date?: string | null
  workbook_order_confirmation_date?: string | null
  workbook_due_date?: string | null
  middleman_commission?: string | null
  middleman_recipient?: string | null
  middleman_commission_basis?: string | null
  middleman_commission_amount?: number | string | null
  middleman_commission_percent?: number | string | null
  middleman_commission_percent_of?: string | null
  internal_details_confirmed_at?: string | null
  internal_details_confirmed_by?: string | null
  /** True when this viewer may not read the commission (see withCommission). */
  commission_restricted?: boolean
  /** The PI's status. "Needed before review" is only true while it is being prepared. */
  status?: string | null
}

/** Draft or returned: the only stages at which the internal details can still be entered. */
export function internalDetailsStillOpen(row: PiInternalDetailsRow): boolean {
  return !row.status || row.status === 'draft' || row.status === 'needs_changes'
}

/** Said while a prepared PI waits only on what the Submit dialog collects. */
export const INTERNAL_DETAILS_AT_SUBMISSION =
  'The order dates are entered in Internal order details and confirmed when this PI is submitted.'

/**
 * The card's status line. While the PI is being prepared, only the middleman
 * answer is something to act on here: the two dates are asked for, and the
 * whole set confirmed, in the Submit for Approval dialog (2026-09-27), so a
 * blank date is not a warning. Once it has gone for review (or beyond), a plain
 * statement that it was never confirmed — "Needed before review" is false by then.
 */
export function internalDetailsStatusLine(row: PiInternalDetailsRow):
  { tone: 'ready' | 'needed' | 'neutral'; text: string } {
  const readiness = internalDetailsReadiness(row)
  if (readiness.ready) {
    return { tone: 'ready', text: `Confirmed ${formatIsoDay(row.internal_details_confirmed_at) ?? ''}`.trim() }
  }
  if (internalDetailsStillOpen(row)) {
    const answer = middlemanAnswerMissing(row)
    if (answer) return { tone: 'needed', text: `Needed before review: ${answer}.` }
    return { tone: 'neutral', text: INTERNAL_DETAILS_AT_SUBMISSION }
  }
  return { tone: 'neutral', text: 'Not confirmed in the app before this PI was sent for review.' }
}

/** What the form holds: every value as the text the inputs show. */
export type PiInternalDetailsForm = {
  order_confirmation_date: string
  due_date: string
  middleman_commission: '' | MiddlemanAnswer
  middleman_recipient: string
  middleman_commission_basis: '' | CommissionBasis
  middleman_commission_amount: string
  middleman_commission_percent: string
  middleman_commission_percent_of: '' | CommissionPercentOf
}

export const MIDDLEMAN_QUESTION = 'Is there a middleman commission?'
export const INTERNAL_DETAILS_TITLE = 'Internal details'
export const INTERNAL_DETAILS_NOTE = 'For BOE only. Never printed on the client PI, PDF or messages.'

/** Every base a percentage may be OF, with the words the form and the reviewer read. */
export const COMMISSION_PERCENT_OF_LABEL: Record<CommissionPercentOf, string> = {
  total_before_gst: 'Total before GST',
  grand_total: 'Grand total (incl. GST)',
  subtotal_after_discount: 'Subtotal (after the deduction)',
  gross_product_amount: 'Gross product amount',
}
/** The order the base is offered in: the commonest agreement first. */
export const COMMISSION_PERCENT_OF_ORDER: readonly CommissionPercentOf[] = [
  'total_before_gst', 'grand_total', 'subtotal_after_discount', 'gross_product_amount',
]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** The form, opened on what the record holds. */
export function internalDetailsForm(row: PiInternalDetailsRow): PiInternalDetailsForm {
  const answer = text(row.middleman_commission)
  const basis = text(row.middleman_commission_basis)
  const of = text(row.middleman_commission_percent_of)
  return {
    order_confirmation_date: text(row.order_confirmation_date).slice(0, 10),
    due_date: text(row.due_date).slice(0, 10),
    middleman_commission: answer === 'yes' || answer === 'no' ? answer : '',
    middleman_recipient: text(row.middleman_recipient),
    middleman_commission_basis: basis === 'amount' || basis === 'percent' ? basis : '',
    middleman_commission_amount: text(row.middleman_commission_amount),
    middleman_commission_percent: text(row.middleman_commission_percent),
    middleman_commission_percent_of: (of in COMMISSION_PERCENT_OF_LABEL ? of : '') as PiInternalDetailsForm['middleman_commission_percent_of'],
  }
}

/**
 * The payload the RPC takes: FULL STATE. A "No" sends nothing else, and each
 * basis sends only its own figure, so a value typed and then abandoned on the
 * other branch is never saved.
 */
export function internalDetailsPayload(form: PiInternalDetailsForm): Record<string, string | null> {
  const blank = (v: string) => (v.trim() === '' ? null : v.trim())
  const yes = form.middleman_commission === 'yes'
  const basis = yes ? form.middleman_commission_basis : ''
  return {
    order_confirmation_date: blank(form.order_confirmation_date),
    due_date: blank(form.due_date),
    middleman_commission: form.middleman_commission || null,
    middleman_recipient: yes ? blank(form.middleman_recipient) : null,
    middleman_commission_basis: basis || null,
    middleman_commission_amount: basis === 'amount' ? blank(form.middleman_commission_amount) : null,
    middleman_commission_percent: basis === 'percent' ? blank(form.middleman_commission_percent) : null,
    middleman_commission_percent_of: basis === 'percent' ? (form.middleman_commission_percent_of || null) : null,
  }
}

/**
 * Problems that stop even a DRAFT save — the shapes the RPC refuses outright.
 * Field-keyed, so the form can put each one under its own input.
 */
export function internalDetailsShapeErrors(
  form: PiInternalDetailsForm,
  grandTotal: number | null,
): Partial<Record<keyof PiInternalDetailsForm, string>> {
  const errors: Partial<Record<keyof PiInternalDetailsForm, string>> = {}
  const confirm = form.order_confirmation_date.trim()
  const due = form.due_date.trim()
  if (confirm && !isRealDate(confirm)) errors.order_confirmation_date = 'Enter a real calendar date.'
  if (due && !isRealDate(due)) errors.due_date = 'Enter a real calendar date.'
  if (confirm && due && isRealDate(confirm) && isRealDate(due) && due < confirm) {
    errors.due_date = 'The due date cannot be before the order confirmation date.'
  }
  if (form.middleman_commission !== 'yes') return errors

  if (form.middleman_recipient.trim().length > 200) errors.middleman_recipient = 'At most 200 characters.'
  if (form.middleman_commission_basis === 'amount') {
    const raw = form.middleman_commission_amount.trim()
    if (raw) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) errors.middleman_commission_amount = 'Enter an amount above zero.'
      else if (Math.round(n * 100) / 100 !== n) errors.middleman_commission_amount = 'At most two decimal places.'
      else if (grandTotal !== null && n > grandTotal) errors.middleman_commission_amount = 'It cannot exceed the grand total.'
    }
  }
  if (form.middleman_commission_basis === 'percent') {
    const raw = form.middleman_commission_percent.trim()
    if (raw) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0 || n > 100) errors.middleman_commission_percent = 'Enter a percentage above 0 and at most 100.'
      else if (Math.round(n * 1000) / 1000 !== n) errors.middleman_commission_percent = 'At most three decimal places.'
    }
  }
  return errors
}

/**
 * THE FIRST THING STILL MISSING, in the database's words and order — null when
 * the answers are complete. Mirrors order_submission_internal_details_problem()
 * except the final "confirm" step, which `internalDetailsReadiness` adds.
 */
export function internalDetailsMissing(row: PiInternalDetailsRow): string | null {
  const confirm = text(row.order_confirmation_date).slice(0, 10)
  const due = text(row.due_date).slice(0, 10)
  if (!confirm) return 'enter the order confirmation date'
  if (!due) return 'enter the due date'
  if (due < confirm) return 'the due date is before the order confirmation date'
  return middlemanAnswerMissing(row)
}

/**
 * The commission half of internalDetailsMissing: the first thing the middleman
 * answer still lacks, or null. Split out so Submit for Approval can collect the
 * two dates itself and still wait on this half (see submissionDetailsSave).
 */
export function middlemanAnswerMissing(row: PiInternalDetailsRow): string | null {
  // A viewer who may not read the commission cannot judge it; the database's
  // own check still does, and the confirmation stamp says it passed.
  if (row.commission_restricted) return null
  const answer = text(row.middleman_commission)
  if (!answer) return `answer "${MIDDLEMAN_QUESTION}"`
  if (answer === 'yes') {
    if (!text(row.middleman_recipient).trim()) return 'name who receives the middleman commission'
    const basis = text(row.middleman_commission_basis)
    if (!basis) return 'give the middleman commission as an amount or a percentage'
    if (basis === 'amount' && !text(row.middleman_commission_amount)) return 'enter the middleman commission amount'
    if (basis === 'percent' && (!text(row.middleman_commission_percent) || !text(row.middleman_commission_percent_of))) {
      return 'enter the middleman commission percentage and what it is a percentage of'
    }
  }
  return null
}

export type InternalDetailsReadiness =
  | { ready: true }
  | { ready: false; problem: string }

/** Ready to submit: complete AND confirmed — the database's full answer. */
export function internalDetailsReadiness(row: PiInternalDetailsRow): InternalDetailsReadiness {
  const missing = internalDetailsMissing(row)
  if (missing) return { ready: false, problem: missing }
  if (!row.internal_details_confirmed_at) return { ready: false, problem: 'confirm the internal details' }
  return { ready: true }
}

/** The sentence the submit dialog shows when it must wait. */
export function internalDetailsSubmitBlock(row: PiInternalDetailsRow): string | null {
  const r = internalDetailsReadiness(row)
  if (r.ready) return null
  const p = r.problem
  return `Before sending this PI for review, ${p} in ${INTERNAL_DETAILS_TITLE}.`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-09-20" (or a timestamp) → "20 Sep 2026"; blank → null. No time zone is involved. */
export function formatIsoDay(value: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value))
  if (!m) return null
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })

/** One line a reviewer reads: "No", "Yes — ASSERT agent, ₹50,000.00", "Yes — X, 2.5% of Total before GST". */
export function describeMiddleman(row: PiInternalDetailsRow): string {
  if (row.commission_restricted) return COMMISSION_RESTRICTED_TEXT
  const answer = text(row.middleman_commission)
  if (!answer) return 'Not answered'
  if (answer === 'no') return 'No'
  const who = text(row.middleman_recipient).trim() || 'recipient not named'
  const basis = text(row.middleman_commission_basis)
  if (basis === 'amount' && text(row.middleman_commission_amount)) {
    return `Yes — ${who}, ${INR.format(Number(row.middleman_commission_amount))}`
  }
  if (basis === 'percent' && text(row.middleman_commission_percent)) {
    const of = text(row.middleman_commission_percent_of) as CommissionPercentOf
    const base = COMMISSION_PERCENT_OF_LABEL[of] ?? 'an unnamed figure'
    return `Yes — ${who}, ${Number(row.middleman_commission_percent)}% of ${base}`
  }
  return `Yes — ${who}, amount not given`
}

/**
 * WHERE THE APP DATE AND THE WORKBOOK DISAGREE. Nothing is chosen silently:
 * the card shows both, and Sales confirms the app value knowing the workbook
 * said something else (or nothing).
 */
export function workbookDateNotes(row: PiInternalDetailsRow): string[] {
  const notes: string[] = []
  const pairs: [string, string | null | undefined, string | null | undefined][] = [
    ['confirmation date', row.order_confirmation_date, row.workbook_order_confirmation_date],
    ['due date', row.due_date, row.workbook_due_date],
  ]
  for (const [label, app, book] of pairs) {
    const a = text(app).slice(0, 10)
    const b = text(book).slice(0, 10)
    if (a && b && a !== b) notes.push(`The workbook's ${label} is ${formatIsoDay(b)}; the app says ${formatIsoDay(a)}.`)
  }
  return notes
}

/** Said when the save never reached the database. Nothing typed is lost: the dialog stays open. */
export const INTERNAL_DETAILS_NETWORK_FAILURE =
  'The internal details could not be saved because BOE could not be reached. Check your connection and press the button again — what you entered is still here.'

/**
 * What the editor says when a save fails. A refusal from the database is shown
 * in its own words (it names the rule); a request that never arrived — the
 * browser's bare "TypeError: Failed to fetch" — is said in plain language.
 */
export function internalDetailsSaveFailure(error: { message?: string; code?: string } | null | undefined): string {
  const message = (error?.message ?? '').trim()
  if (!error?.code && /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(message)) {
    return INTERNAL_DETAILS_NETWORK_FAILURE
  }
  return message || 'The internal details could not be saved.'
}

// THE SUBMISSION CHECKLIST now takes its internal-details gaps from
// withOrderDetailsRequirements (salesOrderDetails.ts), which points each one at
// the field in the PI Draft's Internal order details section.

// ── The two dates, at Submit for Approval (2026-09-27) ───────────────────────
//
// Sales leaves Date of Order Confirmation and Dispatch Date Finalized off the
// client-facing workbook, so the upload no longer asks for them. They are asked
// for where they are REQUIRED: in the Submit for Approval dialog. These are the
// SAME two columns the Internal details editor writes (order_confirmation_date,
// due_date), saved through the SAME RPC (save_order_submission_internal_details)
// and enforced by the SAME trigger (20270123000000). No new field, no second
// rule — only a second place to enter them.

export type SubmissionDates = { order_confirmation_date: string; due_date: string }

/** The words the workbook uses, so Sales recognises the two facts. */
export const SUBMISSION_DATE_LABEL: Record<keyof SubmissionDates, string> = {
  order_confirmation_date: 'Date of Order Confirmation',
  due_date: 'Dispatch Date Finalized',
}

/** The dialog opens on what the record already holds. */
export function submissionDatesFrom(row: PiInternalDetailsRow): SubmissionDates {
  return {
    order_confirmation_date: text(row.order_confirmation_date).slice(0, 10),
    due_date: text(row.due_date).slice(0, 10),
  }
}

/**
 * Field-keyed, so each message sits under its own input. Both dates are
 * REQUIRED here — this is the submission — and the order rule is the RPC's own.
 */
export function submissionDateErrors(dates: SubmissionDates): Partial<Record<keyof SubmissionDates, string>> {
  const errors: Partial<Record<keyof SubmissionDates, string>> = {}
  const confirm = dates.order_confirmation_date.trim()
  const due = dates.due_date.trim()
  if (!confirm) errors.order_confirmation_date = `Enter the ${SUBMISSION_DATE_LABEL.order_confirmation_date}.`
  else if (!isRealDate(confirm)) errors.order_confirmation_date = 'Enter a real calendar date.'
  if (!due) errors.due_date = `Enter the ${SUBMISSION_DATE_LABEL.due_date}.`
  else if (!isRealDate(due)) errors.due_date = 'Enter a real calendar date.'
  if (!errors.order_confirmation_date && !errors.due_date && due < confirm) {
    errors.due_date = `The ${SUBMISSION_DATE_LABEL.due_date} cannot be before the ${SUBMISSION_DATE_LABEL.order_confirmation_date}.`
  }
  return errors
}

/**
 * What still stops Submit that the dialog CANNOT collect: the middleman answer.
 * Null when only the dates (or the confirmation) are outstanding.
 */
export function submissionCommissionBlock(row: PiInternalDetailsRow): string | null {
  const problem = middlemanAnswerMissing(row)
  return problem ? `Before sending this PI for review, ${problem} in ${INTERNAL_DETAILS_TITLE}.` : null
}

export type SubmissionDetailsSave =
  /** The record already holds these dates, confirmed: submit as it is. */
  | { kind: 'none' }
  /** Save these (full state) and confirm them, then submit. */
  | { kind: 'save'; payload: Record<string, string | null>; confirm: true }
  /** Saving here would be unsafe; the message says where to go instead. */
  | { kind: 'refused'; message: string }

/**
 * WHETHER SUBMIT MUST SAVE THE DATES FIRST, and exactly what it sends.
 *
 * The RPC takes FULL STATE, so the payload is the record's own answers with the
 * two dates laid over them — the commission is resent unchanged, never blanked.
 * It CONFIRMS: pressing Submit with the dates and the middleman answer on
 * screen is the confirmation the gate asks for, and the RPC refuses a confirm
 * unless every answer is complete.
 *
 * A viewer who may not read the commission is refused rather than trusted:
 * their copy of it is blank, and resending blank would erase it.
 */
export function submissionDetailsSave(row: PiInternalDetailsRow, dates: SubmissionDates): SubmissionDetailsSave {
  const confirm = dates.order_confirmation_date.trim()
  const due = dates.due_date.trim()
  const held = submissionDatesFrom(row)
  if (confirm === held.order_confirmation_date && due === held.due_date && row.internal_details_confirmed_at) {
    return { kind: 'none' }
  }
  if (row.commission_restricted) {
    return { kind: 'refused', message: `Only someone who can see the middleman commission can confirm the ${INTERNAL_DETAILS_TITLE.toLowerCase()} for this PI.` }
  }
  const payload = internalDetailsPayload({
    ...internalDetailsForm(row),
    order_confirmation_date: confirm,
    due_date: due,
  })
  return { kind: 'save', payload, confirm: true }
}

// ── Confirming at Submit, never silently (2026-09-27, #247 review) ──────────
//
// Saving the dates from the Submit dialog also CONFIRMS the internal details —
// the dates AND the middleman commission answer — because the submission
// trigger requires the confirmation stamp. So the dialog states the answer
// beside the dates and asks for an explicit tick whenever a confirmation will
// be written. No tick, nothing is written.

export const SUBMISSION_CONFIRM_LABEL =
  'I have checked these internal order details. Submitting confirms the dates and the middleman commission answer as this PI’s internal details.'
export const SUBMISSION_CONFIRM_REQUIRED =
  'Tick the box to confirm the internal details, or Cancel and correct them first.'
export const SUBMISSION_MIDDLEMAN_HINT =
  'To change any of them, Cancel and use Internal order details on the PI.'

/** Whether pressing Submit with these dates will write (and so confirm) the internal details. */
export function submissionNeedsConfirmation(row: PiInternalDetailsRow, dates: SubmissionDates): boolean {
  return submissionDetailsSave(row, dates).kind === 'save'
}

const sameDates = (a: SubmissionDates | null, b: SubmissionDates) =>
  !!a && a.order_confirmation_date.trim() === b.order_confirmation_date.trim() && a.due_date.trim() === b.due_date.trim()

export type InternalDatesSubmitResult =
  | { ok: true; data: unknown; saved: SubmissionDates | null }
  /** `message` is a sentence written for the reader; null means "describe `error` as usual". */
  | { ok: false; error: unknown; message: string | null; saved: SubmissionDates | null }

/**
 * SAVE THE DATES (AND CONFIRM), THEN SEND — two transactions, so the second
 * can fail after the first has committed. What this guarantees:
 *
 *   - nothing is written without `acknowledged` when a confirmation is due;
 *   - a refused save sends nothing, and says so;
 *   - a send that fails AFTER the save says the dates are saved and the PI was
 *     not sent, and reports `saved` so a retry with the same dates skips the
 *     save (no second write, no stale-version refusal) and only sends. It says
 *     "Submit again", not a button label: when files were missing, the dialog
 *     is still on its "Submit without these files" step.
 */
export async function submitWithInternalDates(input: {
  row: PiInternalDetailsRow
  dates: SubmissionDates
  acknowledged: boolean
  /** Dates this dialog already saved and confirmed in an earlier attempt. */
  savedEarlier: SubmissionDates | null
  saveDetails: (payload: Record<string, string | null>, confirm: true) =>
    PromiseLike<{ error: { message?: string; code?: string } | null }>
  send: () => PromiseLike<{ data: unknown; error: unknown }>
  describeSendFailure: (error: unknown) => string
}): Promise<InternalDatesSubmitResult> {
  const { row, dates, acknowledged, savedEarlier } = input
  let saved: SubmissionDates | null = sameDates(savedEarlier, dates) ? savedEarlier : null

  if (!saved) {
    const plan = submissionDetailsSave(row, dates)
    if (plan.kind === 'refused') return { ok: false, error: null, message: plan.message, saved: null }
    if (plan.kind === 'save') {
      if (!acknowledged) return { ok: false, error: null, message: SUBMISSION_CONFIRM_REQUIRED, saved: null }
      const { error } = await input.saveDetails(plan.payload, plan.confirm)
      if (error) {
        return { ok: false, error, message: `${internalDetailsSaveFailure(error)} The PI was not sent.`, saved: null }
      }
      saved = { order_confirmation_date: dates.order_confirmation_date.trim(), due_date: dates.due_date.trim() }
    }
  }

  const { data, error } = await input.send()
  if (!error) return { ok: true, data, saved }
  if (!saved) return { ok: false, error, message: null, saved: null }
  return {
    ok: false,
    error,
    message: `The dates were saved and the internal details confirmed, but the PI was not sent. ${input.describeSendFailure(error)} Submit again to retry — the dates are kept and will not be saved twice.`,
    saved,
  }
}
