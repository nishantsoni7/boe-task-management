// ── PI payment card — the pure half ───────────────────────────────────────────
//
// Everything the payment card decides that is NOT a database question: what a
// stored payment status is CALLED, what the summary tiles read, whether the Add
// Payment control is offered, and whether a form submission is allowed to leave
// the browser.
//
// Nothing here touches Supabase, permissions or money arithmetic. The TOTALS are
// computed in the database by pi_submission_payment_summary() in numeric — a
// percentage of a grand total is an eligibility figure, and eligibility figures
// must never pass through binary floating point. This module only formats what
// the database already decided, and the tests assert exactly that: no total is
// recomputed here.

// ── Status vocabulary ─────────────────────────────────────────────────────────
//
// The database has five payment statuses and gains none in this phase.
// `pending_approval` IS "Awaiting Verification" — the product's words for the
// state the column has always described. This map is the only place the two
// vocabularies meet, so a screen can never invent a third.
//
// The two approved statuses both read simply "Verified": the difference between
// them is whether the money is attached to a Confirmed Order, which is a Finance
// concern and says nothing to somebody looking at their own PI.

import {
  PAYMENT_MODES,
  paymentModeLabel as sharedPaymentModeLabel,
  type PaymentMode,
} from './paymentEntry'

export const PI_PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending_approval:    'Awaiting Verification',
  needs_clarification: 'Needs Clarification',
  rejected:            'Rejected',
  approved_unlinked:   'Verified',
  approved_linked:     'Verified',
}

export type PiPaymentTone = 'amber' | 'blue' | 'red' | 'green' | 'neutral'

// Matches the existing Finance status conventions: money confirmed is green,
// money waiting is amber, a question back to the submitter is blue, a refusal is
// red.
export const PI_PAYMENT_STATUS_TONE: Record<string, PiPaymentTone> = {
  pending_approval:    'amber',
  needs_clarification: 'blue',
  rejected:            'red',
  approved_unlinked:   'green',
  approved_linked:     'green',
}

export function piPaymentStatusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  // An unrecognised status says what it is rather than being relabelled as
  // something friendlier that might be untrue.
  return PI_PAYMENT_STATUS_LABEL[status] ?? status
}

export function piPaymentStatusTone(status: string | null | undefined): PiPaymentTone {
  if (!status) return 'neutral'
  return PI_PAYMENT_STATUS_TONE[status] ?? 'neutral'
}

/**
 * Whether a row still counts as money the business is waiting on. Mirrors the
 * database's unverified branch exactly (pending_approval | needs_clarification)
 * — stated here only so a list can style a row, never to compute a total.
 */
export function isAwaitingVerification(status: string | null | undefined): boolean {
  return status === 'pending_approval' || status === 'needs_clarification'
}

// ── The summary the card shows ────────────────────────────────────────────────
//
// A direct projection of the RPC's result. Every figure arrives as a string
// (numeric crosses the wire as a string, deliberately — see the note on parsing
// below) and is kept as a string for display.

export type PiPaymentSummaryRow = {
  allocation_id: string
  allocation_status: 'active' | 'reversed' | string
  allocated_amount: string | number
  payment_id: string
  request_number: string | null
  amount: string | number
  payment_date: string | null
  payment_mode: string | null
  reference: string | null
  remarks: string | null
  status: string
  is_verified: boolean
  admin_note: string | null
  entered_by: string | null
  verified_by: string | null
  created_at: string | null
  verified_at: string | null
  rejected_at: string | null
  proof_count: number
  can_view_proof: boolean
}

export type PiPaymentSummary = {
  submission_id: string
  /** order_submissions.status, so the card can read the position in context. */
  submission_status?: string | null
  grand_total: string | number | null
  verified_amount: string | number
  unverified_amount: string | number
  /**
   * verified + awaiting verification, summed by the database (20261116000000).
   * The figure the SUBMISSION rule reads; it gates no Order. Optional so a
   * summary produced before the migration still types.
   */
  attached_amount?: string | number | null
  verified_percent: string | number | null
  unverified_percent: string | number | null
  attached_percent?: string | number | null
  /** Whether attached payment reaches the requirement. Server-decided. */
  attached_meets_standard?: boolean | null
  /** How much MORE attached payment the submission rule would need. */
  needed_attached_for_submission?: string | number | null
  /** attached_met | attached_partial | no_payment — see paymentGate.ts. */
  submission_position?: string | null
  /** The verified-or-approved-exception answer the Order gate would give now. */
  order_gate_cleared?: boolean | null
  /** Whether the PI ITSELF has been approved against the current submission. */
  pi_approved?: boolean | null
  pi_approved_at?: string | null
  pi_approved_by?: string | null
  pi_approved_by_name?: string | null
  /**
   * How much MORE verified payment is needed, rounded UP to whole paise by the
   * database so the figure shown is always one that actually closes the gate.
   */
  needed_for_standard: string | number | null
  /** The exact 40% figure the gate compares against. */
  required_payment?: string | number | null
  /** Whether verified payment already satisfies the requirement. */
  meets_standard?: boolean | null
  /**
   * Where this PI stands, resolved by the database in the same order
   * approve_order_submission() resolves it. One of the six PaymentPosition
   * codes; never re-derived in the browser.
   */
  approval_position?: string | null
  pending_balance: string | number | null
  standard_percent: string | number
  /**
   * The reduced-payment exception's state: pending | approved | rejected.
   *
   * The RPC also returns the submission's route, and this type deliberately does
   * NOT carry it: the route is named after the pre-Phase-3 declared-advance
   * column, and a payment view that read a declaration would be one step from
   * showing it. The POSITION above is the answer this card needs.
   */
  exception_status?: string | null
  /**
   * Whether an APPROVED exception is still an approval of THIS PI — the same
   * total, the same workbook and the same agreed terms it was decided against.
   * False for a decision taken before Phase 3, which recorded no basis.
   */
  exception_current?: boolean | null
  exception_reason?: string | null
  exception_rejection_reason?: string | null
  /** The agreed commercial terms, as plain text. Never parsed. */
  payment_terms?: string | null
  billing_terms?: string | null
  can_view_all_finance: boolean
  payments: PiPaymentSummaryRow[]
}

/**
 * A money figure for display. Never arithmetic: the value is already correct and
 * the only job here is to render it.
 *
 * `numeric` arrives from PostgREST as a STRING precisely so it is not rounded by
 * JSON's double. Number() is applied only at the formatting boundary, where the
 * value is about to become pixels and can no longer feed a decision.
 */
export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return '—'
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * A percentage for display. NULL means "not computable" — a PI with no stored
 * grand total — and is shown as a dash rather than as 0%, which would read as
 * "nothing received".
 */
export function formatPercent(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`
}

export type PiPaymentTile = { key: string; label: string; value: string; hint?: string }

/**
 * The six tiles, in the confirmed order. Read straight off the RPC result — no
 * total is recomputed here, which the tests assert by feeding deliberately
 * inconsistent figures and requiring them to survive unchanged.
 *
 * DECLARED ADVANCE IS NOT AMONG THEM, and cannot be: the summary type has no
 * field for it and the RPC returns none. What a client agreed to pay is not
 * money that arrived.
 */
export function piPaymentTiles(summary: PiPaymentSummary | null): PiPaymentTile[] {
  if (!summary) return []
  const standard = summary.standard_percent ?? 40
  const tiles: PiPaymentTile[] = [
    // THE GRAND TOTAL LEADS, because every other figure on the card is a part of
    // it and a reader who cannot see the whole cannot judge the parts.
    { key: 'grand',      label: 'Grand total',           value: formatMoney(summary.grand_total) },
    { key: 'verified',   label: 'Verified payment',      value: formatMoney(summary.verified_amount) },
    { key: 'unverified', label: 'Awaiting verification', value: formatMoney(summary.unverified_amount) },
    { key: 'percent',    label: 'Verified payment %',    value: formatPercent(summary.verified_percent),
      hint: 'of grand total, verified only' },
    { key: 'needed',     label: 'Needed for approval',   value: formatMoney(summary.needed_for_standard),
      hint: `to reach the standard ${standard}%` },
    { key: 'balance',    label: 'Pending balance',       value: formatMoney(summary.pending_balance) },
  ]
  // THE ATTACHED PAIR, when the server reports it (20261116000000). What
  // management is shown as "appears to have been received" — verified plus
  // awaiting verification — beside the verified figures, never in place of them.
  if (summary.attached_amount !== undefined && summary.attached_amount !== null) {
    tiles.push({ key: 'attached', label: 'Total attached payment',
      value: formatMoney(summary.attached_amount), hint: 'verified + awaiting verification' })
    tiles.push({ key: 'attached_percent', label: 'Total attached %',
      value: formatPercent(summary.attached_percent), hint: 'of grand total, attached' })
  }
  return tiles
}

export type PiPaymentTermLine = { key: 'payment_terms' | 'billing_terms'; label: string; value: string }

/**
 * The agreed commercial terms, when there are any.
 *
 * ABSENT RATHER THAN EMPTY. A PI that agreed no terms prints no rows at all,
 * because "Payment terms —" reads as a field somebody forgot rather than as a
 * question nobody was asked. Plain text, rendered exactly as it was typed: this
 * is not a schedule and nothing here parses it.
 */
export function piPaymentTermLines(summary: PiPaymentSummary | null): PiPaymentTermLine[] {
  if (!summary) return []
  const lines: PiPaymentTermLine[] = []
  const payment = (summary.payment_terms ?? '').trim()
  const billing = (summary.billing_terms ?? '').trim()
  if (payment !== '') lines.push({ key: 'payment_terms', label: 'Payment terms', value: payment })
  if (billing !== '') lines.push({ key: 'billing_terms', label: 'Billing terms', value: billing })
  return lines
}

// ── Who may add a payment ─────────────────────────────────────────────────────
//
// The BROWSER-SIDE half of the rule. record_pi_submission_payment() re-derives
// all of it server-side under a row lock on every call, so this decides only
// whether a control is OFFERED — never whether it is allowed.
//
// Deliberately the same three routes and no more: an admin, the PI's own people,
// or an explicit finance.allocate holder. Wider Finance access is NOT a route,
// which is why canAllocatePayment is the only Finance capability consulted.

export type PiPaymentActor = {
  userId: string | null
  isAdmin: boolean
  /** finance.allocate — the protected action, never a preset. */
  canAllocatePayment: boolean
}

export type PiPaymentTarget = {
  status: string
  submittedBy: string | null
  createdBy: string | null
  assignedTo: string | null
  /** Set once the PI has become an Order. */
  orderId: string | null
  deletionClaimed: boolean
}

export function canAddPiPayment(actor: PiPaymentActor, pi: PiPaymentTarget): boolean {
  // A PI that has become an Order is out of scope for this route: the money
  // belongs to the Order and the existing Finance path records it there.
  if (pi.orderId) return false
  if (pi.status === 'approved' || pi.status === 'rejected') return false
  if (pi.deletionClaimed) return false

  if (actor.isAdmin) return true
  if (actor.canAllocatePayment) return true

  // Ownership. Compared only when there is an actor to compare — a null userId
  // must never match a null column, which is the same three-valued trap the
  // server-side check coalesces away.
  if (!actor.userId) return false
  return pi.submittedBy === actor.userId
      || pi.createdBy === actor.userId
      || pi.assignedTo === actor.userId
}

// ── The Add Payment form ──────────────────────────────────────────────────────
//
// Three mandatory fields and three optional ones. The validation below mirrors
// the RPC's, so the form refuses locally what the database would refuse anyway —
// and the RPC still re-derives every rule, because a browser check is a
// convenience and never a boundary.

// ONE SOURCE, RE-EXPORTED UNDER ITS OLD NAME. These used to be declared here as
// well as in four other files. The list is now lib/finance/paymentEntry
// (20261013000000, four values since 20261014000000); this alias stays so PI
// callers need no edit, and so there is exactly one place a fifth mode could
// ever be added.
export const PI_PAYMENT_MODES = PAYMENT_MODES

export type PiPaymentMode = PaymentMode

/**
 * How a stored mode is written down — the SHARED formatter, not a second one.
 *
 * It used to look the value up in the OFFERED list alone, so the moment that
 * list stopped being every storable value (20261014000000 keeps the five legacy
 * ones readable but refuses them for new entries) a historical row would have
 * printed its raw column value on a PI's payment card while every Finance screen
 * printed "Bank Transfer". Two formatters, one fact, two answers.
 */
export const paymentModeLabel = sharedPaymentModeLabel

export type PiPaymentFormState = {
  amount: string
  paymentDate: string
  paymentMode: string
  reference: string
  remarks: string
}

export const EMPTY_PI_PAYMENT_FORM: PiPaymentFormState = {
  amount: '', paymentDate: '', paymentMode: '', reference: '', remarks: '',
}

export type PiPaymentFormErrors = Partial<Record<'amount' | 'paymentDate' | 'paymentMode', string>>

/**
 * Validates the three mandatory fields. Reference, remarks and proof are
 * optional by product decision and are never validated into a blocker.
 *
 * `todayIso` is injected rather than read from the clock so the rule is testable
 * and so a machine whose clock is ahead cannot silently refuse a valid entry.
 */
export function validatePiPaymentForm(
  form: PiPaymentFormState,
  todayIso: string,
): PiPaymentFormErrors {
  const errors: PiPaymentFormErrors = {}

  const raw = form.amount.trim()
  if (raw === '') {
    errors.amount = 'Enter the amount received.'
  } else {
    // Refused, never rounded — the figure that reaches the ledger has to be the
    // figure somebody typed. Matches the RPC's round(,2) rule.
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      errors.amount = 'Enter a positive amount in rupees and paise.'
    } else if (Number(raw) <= 0) {
      errors.amount = 'The amount must be more than zero.'
    }
  }

  const date = form.paymentDate.trim()
  if (date === '') {
    errors.paymentDate = 'Enter the payment date.'
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    errors.paymentDate = 'Enter a valid date.'
  } else if (date > todayIso) {
    errors.paymentDate = 'The payment date cannot be in the future.'
  }

  if (form.paymentMode.trim() === '') {
    errors.paymentMode = 'Choose how the payment was made.'
  } else if (!PI_PAYMENT_MODES.some(m => m.value === form.paymentMode)) {
    errors.paymentMode = 'Choose one of the listed payment modes.'
  }

  return errors
}

export function isPiPaymentFormValid(form: PiPaymentFormState, todayIso: string): boolean {
  return Object.keys(validatePiPaymentForm(form, todayIso)).length === 0
}

/**
 * The payload the RPC accepts, and nothing else. Optional fields collapse to
 * null when blank so the database stores an absence rather than an empty string.
 *
 * THERE IS NO CLIENT, NO ACTOR, NO STATUS AND NO ALLOCATION HERE, deliberately:
 * every one of those is server-derived, and a payload field for any of them
 * would be a field somebody could forge.
 */
export function buildPiPaymentPayload(submissionId: string, form: PiPaymentFormState) {
  const trimmed = (v: string) => {
    const t = v.trim()
    return t === '' ? null : t
  }
  return {
    p_submission_id: submissionId,
    p_amount:        Number(form.amount.trim()),
    p_payment_date:  form.paymentDate.trim(),
    p_payment_mode:  form.paymentMode,
    p_reference:     trimmed(form.reference),
    p_remarks:       trimmed(form.remarks),
  }
}

/**
 * Double-submit protection, as a pure decision.
 *
 * A payment is not idempotent — pressing the button twice records the money
 * twice — so the guard is not decoration. Kept here rather than inline in the
 * component so it can be tested without rendering: a submission is permitted
 * only when the form is valid AND nothing is already in flight.
 */
export function canSubmitPiPayment(input: {
  form: PiPaymentFormState
  todayIso: string
  saving: boolean
  submitted: boolean
}): boolean {
  if (input.saving || input.submitted) return false
  return isPiPaymentFormValid(input.form, input.todayIso)
}

// ── Result wording ────────────────────────────────────────────────────────────
//
// A recorded payment has NOT been received-and-verified, and the success message
// must not imply that it has. The wording states what actually happened: it was
// recorded, and Finance will decide.

export const PI_PAYMENT_RECORDED_TITLE = 'Payment recorded'
export const PI_PAYMENT_RECORDED_BODY =
  'It is now awaiting verification by Finance. Nothing is confirmed as received until they verify it.'

/** Proof upload failed but the payment is real and must not be presented as lost. */
export const PI_PAYMENT_PROOF_FAILED =
  'The payment was recorded, but the proof file could not be uploaded. You can add it from Finance later.'

export function piPaymentErrorMessage(raw: string | null | undefined): string {
  const message = (raw ?? '').trim()
  if (message === '') return 'Could not record the payment. Please try again.'

  // The RPC's coded refusals, turned into something a salesperson can act on.
  const CODES: [string, string][] = [
    ['PAYMENT_AMOUNT_INVALID',            'Enter a positive amount in rupees and paise.'],
    ['PAYMENT_DATE_REQUIRED',             'Enter the payment date.'],
    ['PAYMENT_DATE_FUTURE',               'The payment date cannot be in the future.'],
    ['PAYMENT_MODE_INVALID',              'Choose one of the listed payment modes.'],
    ['PI_PAYMENT_NOT_PERMITTED',          'You do not have permission to record a payment against this PI.'],
    ['ORDER_SUBMISSION_CONVERTED',        'This PI is now an Order. Record the payment against the Order instead.'],
    ['ORDER_SUBMISSION_REJECTED',         'This PI has been rejected and cannot receive a payment.'],
    ['ORDER_SUBMISSION_DELETION_CLAIMED', 'This PI is reserved for deletion and cannot receive a payment.'],
    ['ORDER_SUBMISSION_NO_CLIENT',        'This PI has no client name on file, so a payment cannot be attributed.'],
    ['ALLOCATION_EXCEEDS_PAYMENT',        'That amount is more than the payment has left to allocate.'],
  ]
  for (const [code, friendly] of CODES) {
    if (message.includes(code)) return friendly
  }
  return 'Could not record the payment. Please try again.'
}

// ── The call itself ───────────────────────────────────────────────────────────
//
// Wrapped so the SCREEN never handles a database error object. The PI screens are
// held to a rule (draftsAccess.test.ts) that a failure shows a fixed sentence and
// the database's own message never reaches the file, let alone the user — and the
// only way to keep that true is for the raw error to be consumed here, where it is
// mapped to one of the sentences above and nothing else can escape.

type PaymentRpcClient = {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>
}

export type RecordPiPaymentResult =
  | { ok: true; paymentRequestId: string | null }
  | { ok: false; message: string }

export async function recordPiPayment(
  client: PaymentRpcClient,
  submissionId: string,
  form: PiPaymentFormState,
): Promise<RecordPiPaymentResult> {
  const { data, error } = await client.rpc(
    'record_pi_submission_payment', buildPiPaymentPayload(submissionId, form))

  if (error) return { ok: false, message: piPaymentErrorMessage(error.message ?? null) }

  const paymentRequestId =
    (data as { payment_request_id?: string } | null)?.payment_request_id ?? null
  return { ok: true, paymentRequestId }
}

/**
 * Reads the card's summary. A refusal resolves to null rather than throwing:
 * a caller who may not read payments simply has no card content, which is not a
 * page failure.
 */
export async function loadPiPaymentSummary(
  client: PaymentRpcClient,
  submissionId: string,
): Promise<PiPaymentSummary | null> {
  const { data, error } = await client.rpc(
    'pi_submission_payment_summary', { p_submission_id: submissionId })
  if (error) return null
  return (data as PiPaymentSummary | null) ?? null
}
