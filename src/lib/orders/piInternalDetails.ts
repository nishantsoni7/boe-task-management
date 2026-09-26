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

/** The columns, as PI_DRAFT_DETAIL_COLUMNS reads them. */
export const PI_INTERNAL_DETAIL_COLUMNS = [
  'workbook_order_confirmation_date', 'workbook_due_date',
  'middleman_commission', 'middleman_recipient', 'middleman_commission_basis',
  'middleman_commission_amount', 'middleman_commission_percent', 'middleman_commission_percent_of',
  'internal_details_confirmed_at', 'internal_details_confirmed_by',
] as const

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
