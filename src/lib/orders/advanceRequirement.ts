// The advance requirement a PI carries into review, and the exception an
// employee may ask management to allow.
//
// WHAT THIS RECORDS, AND WHAT IT DOES NOT
// ---------------------------------------
// A COMMERCIAL CONDITION. Not a payment.
//
// BOE requires 40% of the grand total as an advance before an order is worked.
// This module is about the employee DECLARING which condition their PI is being
// submitted under, and about management ACCEPTING or REFUSING a proposal to
// start on less. Nothing here records, requests, confirms or reconciles money
// received — the words throughout are "advance requirement", "proposed advance"
// and "exception request", and the screens keep saying that no payment has been
// recorded or requested.
//
// WHY A MODULE AND NOT INLINE CONDITIONS
// --------------------------------------
// Three screens ask the same questions — the submit dialog, the management
// review card and the read-only employee view — and the answers depend on the
// record's status, the declared condition, the decision state, whether the
// viewer owns the record and whether they hold the exception permission.
// Written inline that is a dozen nearly-identical boolean expressions spread
// across two files. Written here it is one set of rules with tests around it.
//
// NONE OF THIS IS AUTHORIZATION. Every rule below decides what to RENDER and
// what to send. The database decides what may HAPPEN, and decides it again for
// every call:
//
//   submit_order_submission_with_advance  owner (for an exception),
//                                         orders.create, draft/needs_changes,
//                                         a stored grand total, and the whole
//                                         percentage and reason validation
//   approve_pi_advance_exception          orders.approve_advance_exception,
//                                         submitted, pending only
//   reject_pi_advance_exception           the same, plus a mandatory reason
//
// So a hidden control is a courtesy and a defeated one gets a refusal from
// Postgres.

import { PI_ADVANCE_PERCENT, computeAdvanceAmount, formatInr } from '@/lib/pi/previewView'

// ── The vocabulary ────────────────────────────────────────────────────────────

/** Which advance condition a PI was submitted under. */
export type AdvanceCondition = 'standard' | 'exception'

/** Where an exception request stands. */
export type AdvanceExceptionStatus = 'pending' | 'approved' | 'rejected'

/**
 * The standard requirement, re-exported rather than restated.
 *
 * ONE CONSTANT. previewView.ts owns it because the commercial summary needed it
 * first; everything about the advance workflow reads it from there, and the
 * database's own order_submission_standard_advance_percent() is asserted equal
 * to it by a repository test.
 */
export const ADVANCE_STANDARD_PERCENT = PI_ADVANCE_PERCENT

/**
 * Decimal places allowed on a proposed percentage.
 *
 * MUST MATCH THE DATABASE, which refuses anything finer with
 * ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID rather than rounding it into a figure
 * the employee never typed. The browser limit exists so somebody is told while
 * they type; the database limit is the one that decides.
 */
export const ADVANCE_PERCENT_MAX_DECIMALS = 2

/** The cap on both the request reason and the rejection reason, after trimming. */
export const ADVANCE_REASON_MAX_LENGTH = 1000

// ── Copy ──────────────────────────────────────────────────────────────────────

export const ADVANCE_SECTION_TITLE = 'Advance requirement'

export const ADVANCE_STANDARD_LABEL = `Standard advance (${ADVANCE_STANDARD_PERCENT}%)`
export const ADVANCE_EXCEPTION_LABEL = 'Request advance exception'

export const ADVANCE_STANDARD_HINT =
  `The usual condition: ${ADVANCE_STANDARD_PERCENT}% of the grand total is required before the order is worked.`
export const ADVANCE_EXCEPTION_HINT =
  `Propose less than ${ADVANCE_STANDARD_PERCENT}%. Management decides before this PI can go further.`

export const ADVANCE_PERCENT_LABEL = 'Proposed advance %'
export const ADVANCE_REASON_LABEL = 'Why a lower advance is needed *'
export const ADVANCE_REASON_PLACEHOLDER =
  'Say what the client has agreed and why the business should accept it…'

/** What 0% means, stated so nobody has to infer it from an empty figure. */
export const ADVANCE_ZERO_EXPLANATION = 'No advance requested — the order would start with nothing received.'

/**
 * The payment boundary, restated wherever an advance figure appears.
 *
 * previewView.ts already carries ADVANCE_NOT_A_PAYMENT_NOTE for the commercial
 * summary. This is its counterpart for the workflow screens, and it says the
 * same thing for the same reason: an amount on screen beside the word "advance"
 * is read as money received unless the screen says otherwise.
 */
export const ADVANCE_NOT_A_PAYMENT =
  'This records the advance requirement only. No payment has been recorded, requested or received.'

export const ADVANCE_EXCEPTION_STATUS_LABEL: Record<AdvanceExceptionStatus, string> = {
  pending:  'Pending decision',
  approved: 'Approved',
  rejected: 'Rejected',
}

export const APPROVE_EXCEPTION_BUTTON_LABEL = 'Approve Exception'
export const REJECT_EXCEPTION_BUTTON_LABEL = 'Reject Exception'
export const REJECT_EXCEPTION_REASON_LABEL = 'Why the proposed advance is refused *'
export const REJECT_EXCEPTION_REASON_REQUIRED =
  'A reason is required, and the employee sees it as the correction instruction.'

/**
 * What the employee is told when their proposal was refused.
 *
 * The PI is back with them and the reason is already rendered verbatim as the
 * record's correction instruction, so this explains the CHOICE they now have
 * rather than repeating the words above it.
 */
export const ADVANCE_REJECTED_INSTRUCTION =
  `Submit again under the standard ${ADVANCE_STANDARD_PERCENT}% requirement, or propose a different exception with a new reason.`

// ── The persisted state, as the page reads it ─────────────────────────────────

/** The advance columns of one order_submissions row. */
export type PersistedAdvance = {
  advance_condition: string | null
  advance_exception_percent: number | string | null
  advance_exception_reason: string | null
  advance_exception_status: string | null
  advance_exception_requested_by: string | null
  advance_exception_requested_at: string | null
  advance_exception_decided_by: string | null
  advance_exception_decided_at: string | null
  advance_exception_rejection_reason: string | null
}

/** The advance columns, named explicitly so `select('*')` is never needed. */
export const PI_ADVANCE_COLUMNS: readonly string[] = [
  'advance_condition',
  'advance_exception_percent',
  'advance_exception_reason',
  'advance_exception_status',
  'advance_exception_requested_by',
  'advance_exception_requested_at',
  'advance_exception_decided_by',
  'advance_exception_decided_at',
  'advance_exception_rejection_reason',
]

/**
 * A numeric column as a number, or null.
 *
 * PostgREST returns `numeric` as a STRING, to avoid the precision JSON numbers
 * lose. Parsing it here — once — is why nothing downstream has to remember that.
 */
export function advanceNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

const asCondition = (value: string | null | undefined): AdvanceCondition | null =>
  value === 'standard' || value === 'exception' ? value : null

const asStatus = (value: string | null | undefined): AdvanceExceptionStatus | null =>
  value === 'pending' || value === 'approved' || value === 'rejected' ? value : null

// ── The Phase C rule, in the browser ──────────────────────────────────────────

/**
 * Whether a record satisfies the advance requirement.
 *
 * THE MIRROR OF public.order_submission_advance_ready(text, numeric, text), and
 * it must stay one:
 *
 *   ready  ⇔  standard, OR an approved exception with 0 <= percent < 40
 *
 * Pending, rejected, undeclared and malformed are all false. This decides what a
 * screen SAYS. The database decides what may happen, and there is no approval
 * RPC to reach in this phase whatever either of them answers.
 */
export function advanceIsReady(advance: PersistedAdvance): boolean {
  const condition = asCondition(advance.advance_condition)
  if (condition === 'standard') return true
  if (condition !== 'exception') return false
  if (asStatus(advance.advance_exception_status) !== 'approved') return false
  const percent = advanceNumber(advance.advance_exception_percent)
  return percent !== null && percent >= 0 && percent < ADVANCE_STANDARD_PERCENT
}

// ── What to show ──────────────────────────────────────────────────────────────

export type AdvanceView = {
  /** True when the record was submitted before Phase B and declared nothing. */
  undeclared: boolean
  condition: AdvanceCondition | null
  /** `${percent}%`, or null when nothing was declared. */
  conditionLabel: string | null
  /** The standard requirement, always shown so the comparison is visible. */
  standardPercentLabel: string
  /** The standard requirement in rupees, or an em dash. */
  standardAmount: string
  /** The proposed percentage, when there is an exception. */
  exceptionPercentLabel: string | null
  /** The proposed advance in rupees, derived from the CURRENT grand total. */
  exceptionAmount: string | null
  /** True only for a 0% proposal, which needs its meaning spelled out. */
  isZeroPercent: boolean
  /** The employee's mandatory reason, trimmed, or null. */
  requestReason: string | null
  status: AdvanceExceptionStatus | null
  statusLabel: string | null
  /** Management's reason for refusing, trimmed, or null. */
  rejectionReason: string | null
  requestedById: string | null
  requestedAtIso: string | null
  decidedById: string | null
  decidedAtIso: string | null
  /** The Phase C predicate, for this record. */
  ready: boolean
}

/**
 * Everything the three screens print about one record's advance condition.
 *
 * THE RUPEE FIGURES ARE DERIVED, ALWAYS, from the grand total passed in — which
 * is the CURRENT persisted one. An approved exception is a decision about a
 * PERCENTAGE, so when a corrected PI changes the total, the figure shown moves
 * with it rather than reporting an amount nobody agreed to. That is also why the
 * database stores no amount to disagree with.
 *
 * A grand total of null yields em dashes rather than zeroes: an unknown amount
 * is not ₹0, and the submit path refuses to declare anything against one.
 */
export function describeAdvance(
  advance: PersistedAdvance,
  grandTotal: number | null,
): AdvanceView {
  const condition = asCondition(advance.advance_condition)
  const status = asStatus(advance.advance_exception_status)
  const percent = advanceNumber(advance.advance_exception_percent)
  const requestReason = (advance.advance_exception_reason ?? '').trim() || null
  const rejectionReason = (advance.advance_exception_rejection_reason ?? '').trim() || null

  const standard = computeAdvanceAmount(grandTotal, ADVANCE_STANDARD_PERCENT)
  const proposed = condition === 'exception' && percent !== null
    ? computeAdvanceAmount(grandTotal, percent)
    : null

  return {
    undeclared: condition === null,
    condition,
    conditionLabel: condition === 'standard'
      ? ADVANCE_STANDARD_LABEL
      : condition === 'exception'
        ? ADVANCE_EXCEPTION_LABEL
        : null,
    standardPercentLabel: `${ADVANCE_STANDARD_PERCENT}%`,
    standardAmount: standard === null ? '—' : formatInr(standard),
    exceptionPercentLabel: condition === 'exception' && percent !== null
      ? `${formatPercent(percent)}%`
      : null,
    exceptionAmount: proposed === null ? null : formatInr(proposed),
    isZeroPercent: condition === 'exception' && percent === 0,
    requestReason,
    status,
    statusLabel: status === null ? null : ADVANCE_EXCEPTION_STATUS_LABEL[status],
    rejectionReason,
    requestedById: advance.advance_exception_requested_by,
    requestedAtIso: advance.advance_exception_requested_at,
    decidedById: advance.advance_exception_decided_by,
    decidedAtIso: advance.advance_exception_decided_at,
    ready: advanceIsReady(advance),
  }
}

/**
 * A percentage with no trailing zeroes: 12.5, 12, 12.05 — never 12.50 or 12.00.
 *
 * The employee typed one of at most two decimal places and should see what they
 * typed, not a padded rendering of it.
 */
export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return '—'
  return String(Number(percent.toFixed(ADVANCE_PERCENT_MAX_DECIMALS)))
}

// ── Who may act ───────────────────────────────────────────────────────────────

export type AdvanceActionInput = {
  status: string
  advance: PersistedAdvance
  /** orders.approve_advance_exception, as deriveOrdersCapabilities resolved it. */
  canDecideException: boolean
}

export type AdvanceActions = {
  /** There is a proposal waiting for somebody. */
  isPending: boolean
  /** Approve Exception / Reject Exception may be drawn. */
  canDecide: boolean
}

/**
 * Whether the exception decision controls belong on screen.
 *
 * BOTH CONDITIONS, ALWAYS. A pending request on a PI that is no longer submitted
 * cannot be decided — the RPCs refuse it, and so does the database guard — so
 * offering the buttons there would be offering a refusal. And a viewer without
 * the permission never sees a control, though they still see the STATE: the
 * decision is part of the record's story, and hiding it from somebody who can
 * read the PI would leave them wondering why it is waiting.
 */
export function describeAdvanceActions(input: AdvanceActionInput): AdvanceActions {
  const isPending =
    input.advance.advance_condition === 'exception'
    && input.advance.advance_exception_status === 'pending'
    && input.status === 'submitted'

  return { isPending, canDecide: isPending && input.canDecideException }
}

// ── The employee's choice, on its way to the database ─────────────────────────

export type AdvanceSelection =
  | { condition: 'standard' }
  | { condition: 'exception'; percent: number; reason: string }

export type AdvanceValidation =
  | { ok: true; value: AdvanceSelection }
  | { ok: false; message: string }

export const ADVANCE_PERCENT_REQUIRED = 'Enter the advance percentage being proposed.'
export const ADVANCE_PERCENT_OUT_OF_RANGE =
  `An exception must be at least 0% and below the standard ${ADVANCE_STANDARD_PERCENT}%.`
export const ADVANCE_PERCENT_TOO_PRECISE =
  `Use at most ${ADVANCE_PERCENT_MAX_DECIMALS} decimal places.`
export const ADVANCE_REASON_REQUIRED = 'Say why a lower advance is being proposed.'
export const ADVANCE_REASON_TOO_LONG =
  `Please shorten the reason to ${ADVANCE_REASON_MAX_LENGTH} characters or fewer.`
export const ADVANCE_TOTAL_MISSING =
  'This PI has no stored grand total, so an advance requirement cannot be declared against it. Upload a corrected PI with Change PI.'

/**
 * How many decimal places a typed figure actually carries.
 *
 * READ FROM THE TEXT, not from the parsed number. `Number('12.50')` is 12.5 and
 * would pass a check written against the value, while "12.345" and "12.3450"
 * are genuinely different things to say about what somebody typed. Exponent
 * forms are rejected outright by the shape test below, so this only ever sees a
 * plain decimal.
 */
function decimalPlaces(raw: string): number {
  const dot = raw.indexOf('.')
  return dot < 0 ? 0 : raw.length - dot - 1
}

/** A plain, non-exponential decimal. "1e1", "Infinity", "NaN" and "" are not. */
const PLAIN_DECIMAL = /^\d*\.?\d*$/

/**
 * The employee's declaration, as it will be sent — or the reason it cannot be.
 *
 * VALIDATED THE WAY THE DATABASE VALIDATES IT, and in the same order, so what
 * the dialog refuses is what the RPC would have refused. Every rule here is
 * re-derived in submit_order_submission_advance_internal, which is the one that
 * decides; this exists so somebody is told while they type rather than after a
 * round trip.
 *
 * A MISSING GRAND TOTAL FAILS CLOSED, for both conditions. The employee must not
 * be allowed to declare an advance against an amount nobody knows — 40% of an
 * unknown is not a figure, and neither is 12% of one.
 */
export function validateAdvanceSelection(input: {
  condition: AdvanceCondition
  /** Exactly what is in the percentage box. Never a pre-parsed number. */
  percentText: string
  reason: string
  /** The PERSISTED grand total. Null means the workbook printed no figure. */
  grandTotal: number | null
}): AdvanceValidation {
  if (input.grandTotal === null || !Number.isFinite(input.grandTotal)) {
    return { ok: false, message: ADVANCE_TOTAL_MISSING }
  }

  if (input.condition === 'standard') return { ok: true, value: { condition: 'standard' } }

  const raw = input.percentText.trim()
  if (raw === '' || raw === '.') return { ok: false, message: ADVANCE_PERCENT_REQUIRED }
  if (!PLAIN_DECIMAL.test(raw)) return { ok: false, message: ADVANCE_PERCENT_OUT_OF_RANGE }

  const percent = Number(raw)
  if (!Number.isFinite(percent)) return { ok: false, message: ADVANCE_PERCENT_OUT_OF_RANGE }
  if (percent < 0 || percent >= ADVANCE_STANDARD_PERCENT) {
    return { ok: false, message: ADVANCE_PERCENT_OUT_OF_RANGE }
  }
  if (decimalPlaces(raw) > ADVANCE_PERCENT_MAX_DECIMALS) {
    return { ok: false, message: ADVANCE_PERCENT_TOO_PRECISE }
  }

  const reason = input.reason.trim()
  if (reason === '') return { ok: false, message: ADVANCE_REASON_REQUIRED }
  if (reason.length > ADVANCE_REASON_MAX_LENGTH) {
    return { ok: false, message: ADVANCE_REASON_TOO_LONG }
  }

  return { ok: true, value: { condition: 'exception', percent, reason } }
}

/**
 * The choice the dialog opens on, for this record.
 *
 * A NEW SUBMISSION DEFAULTS TO STANDARD, which is the ordinary path and the one
 * the business prefers. A RESUBMISSION OPENS ON WHATEVER THE RECORD ALREADY
 * SAYS, so a PI returned for an unrelated correction does not silently switch
 * the employee's advance condition out from under them while they fix a fabric
 * name — and an approved exception resubmitted unchanged stays approved rather
 * than going back for a second decision.
 */
export function initialAdvanceSelection(advance: PersistedAdvance): {
  condition: AdvanceCondition
  percentText: string
  reason: string
} {
  if (asCondition(advance.advance_condition) === 'exception') {
    const percent = advanceNumber(advance.advance_exception_percent)
    return {
      condition: 'exception',
      percentText: percent === null ? '' : formatPercent(percent),
      reason: (advance.advance_exception_reason ?? '').trim(),
    }
  }
  return { condition: 'standard', percentText: '', reason: '' }
}

/**
 * The live rupee preview beside the percentage box.
 *
 * Returns an em dash rather than ₹0 for an unusable input, so a half-typed "1."
 * shows nothing instead of flashing a figure nobody proposed. A genuine 0% is
 * ₹0 and says so, with ADVANCE_ZERO_EXPLANATION beside it.
 */
export function previewAdvanceAmount(
  percentText: string,
  grandTotal: number | null,
): string {
  const raw = percentText.trim()
  if (raw === '' || !PLAIN_DECIMAL.test(raw)) return '—'
  const percent = Number(raw)
  if (!Number.isFinite(percent) || percent < 0 || percent >= ADVANCE_STANDARD_PERCENT) return '—'
  const amount = computeAdvanceAmount(grandTotal, percent)
  return amount === null ? '—' : formatInr(amount)
}
