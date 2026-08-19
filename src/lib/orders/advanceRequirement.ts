// The advance requirement a PI carries into review, and the exception an
// employee may ask management to allow.
//
// WHAT THIS RECORDS, AND WHAT IT DOES NOT
// ---------------------------------------
// A COMMERCIAL CONDITION. Not a payment.
//
// BOE requires 40% of the grand total as an advance before an order is worked.
// This module is about the employee DECLARING THE ADVANCE AMOUNT their PI is
// being submitted under, and about management ACCEPTING or REFUSING a proposal
// to start on less. Nothing here records, requests, verifies, links or
// reconciles money received — the words throughout are "declared advance",
// "proposed advance" and "exception request", and the screens keep saying that
// payment verification and linking are a separate thing entirely.
//
// THE AMOUNT IS PRIMARY AND THE PERCENTAGE IS DERIVED. What a client agrees to
// is a figure; "40%" is what that figure comes to. So the employee types rupees,
// the screen shows the percentage they work out to, and whether the declaration
// is standard or an exception is decided by comparing the AMOUNT with 40% of the
// grand total — never by comparing a percentage that has been rounded for
// display.
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
//   submit_order_submission_with_advance_amount
//                                         owner (for an exception),
//                                         orders.create, draft/needs_changes,
//                                         a stored grand total, and the whole
//                                         amount and reason validation
//   approve_pi_advance_exception          orders.approve_advance_exception,
//                                         submitted, pending only
//   reject_pi_advance_exception           the same, plus a mandatory reason
//
// So a hidden control is a courtesy and a defeated one gets a refusal from
// Postgres.

import { PI_ADVANCE_PERCENT, computeAdvanceAmount, formatInr } from '@/lib/pi/previewView'

// ── The vocabulary ────────────────────────────────────────────────────────────

/** Which advance condition a PI was submitted under. THE DATABASE'S WORD. */
export type AdvanceCondition = 'standard' | 'exception'

/**
 * The three choices an employee is actually offered. THE SCREEN'S WORD.
 *
 * WHY THREE WHEN THE DATABASE HAS TWO. "Exception" is one column value covering
 * two different business decisions — start on less, and start on nothing — and
 * an employee who needs the second one should not have to discover that it is
 * the first one with a zero typed into it. A choice nobody can find is a choice
 * that does not exist, which is exactly what happened: proceeding without an
 * advance was reachable only by knowing that 0 was an accepted percentage.
 *
 * So the SCREEN offers three and the DATABASE still stores two:
 *
 *   standard  →  advance_condition = 'standard',  amount >= 40% of the total
 *   reduced   →  advance_condition = 'exception', 0 < amount < 40% of the total
 *   none      →  advance_condition = 'exception',  amount = 0
 *
 * There is NO third database condition, and there must not be one: ₹0 is the
 * exception the applied migration already models, already validates and already
 * routes through the same pending/approved/rejected decision.
 */
export type AdvanceChoice = 'standard' | 'reduced' | 'none'

/** Every choice, in the order they are drawn. */
export const ADVANCE_CHOICES: readonly AdvanceChoice[] = ['standard', 'reduced', 'none']

/**
 * The declaration as the dialog holds it WHILE IT IS BEING MADE.
 *
 * THE AMOUNT IS WHAT IS TYPED, and the percentage is what it comes to. That is
 * the way round the business works: what a client agrees to is a FIGURE, and
 * "40%" is what that figure happens to be a proportion of.
 *
 * Text, not a number, because "1250.005" and "1250.01" are different things to
 * say and the difference is only visible before parsing. See decimalPlaces().
 */
export type AdvanceDeclaration = {
  choice: AdvanceChoice
  /** Exactly what is in the amount box, in rupees. Never a pre-parsed number. */
  amountText: string
  reason: string
}

/** The database condition a choice becomes. */
export const advanceChoiceCondition = (choice: AdvanceChoice): AdvanceCondition =>
  choice === 'standard' ? 'standard' : 'exception'

/** Whether a choice must carry a reason. Both exceptions do; the standard does not. */
export const advanceChoiceNeedsReason = (choice: AdvanceChoice): boolean => choice !== 'standard'

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
 * Decimal places a derived percentage is shown to.
 *
 * TRUNCATED TO THIS, never rounded, so a figure below the standard requirement
 * can never be displayed as meeting it. See derivedAdvancePercent().
 */
export const ADVANCE_PERCENT_MAX_DECIMALS = 2

/**
 * Decimal places allowed on a declared amount.
 *
 * RUPEES AND PAISE. MUST MATCH THE DATABASE, which refuses anything finer with
 * ORDER_SUBMISSION_ADVANCE_AMOUNT_INVALID rather than rounding it into a figure
 * the employee never typed.
 */
export const ADVANCE_AMOUNT_MAX_DECIMALS = 2

/** The cap on both the request reason and the rejection reason, after trimming. */
export const ADVANCE_REASON_MAX_LENGTH = 1000

// ── Copy ──────────────────────────────────────────────────────────────────────

export const ADVANCE_SECTION_TITLE = 'Advance requirement'

// ── The three choices, as they are drawn ──

export const ADVANCE_STANDARD_LABEL = `Advance: ${ADVANCE_STANDARD_PERCENT}% or above`
export const ADVANCE_REDUCED_LABEL = `Reduced advance: below ${ADVANCE_STANDARD_PERCENT}%`
export const ADVANCE_NONE_LABEL = 'No advance: 0%'

export const ADVANCE_CHOICE_LABEL: Record<AdvanceChoice, string> = {
  standard: ADVANCE_STANDARD_LABEL,
  reduced:  ADVANCE_REDUCED_LABEL,
  none:     ADVANCE_NONE_LABEL,
}

export const ADVANCE_STANDARD_HINT =
  `Declare the amount agreed. It must be at least ${ADVANCE_STANDARD_PERCENT}% of the grand total, and may be more.`
export const ADVANCE_REDUCED_HINT =
  `Declare an amount above ₹0 and below ${ADVANCE_STANDARD_PERCENT}% of the grand total. Management decides before this PI can go further.`
/**
 * What choosing "No advance" actually commits somebody to.
 *
 * It says APPROVAL IS REQUIRED, and deliberately says nothing about payment:
 * this is a request to start work on nothing received, not a record that
 * anything was received, waived or written off.
 */
export const ADVANCE_NONE_HINT = 'Management approval is required to proceed without advance.'

export const ADVANCE_CHOICE_HINT: Record<AdvanceChoice, string> = {
  standard: ADVANCE_STANDARD_HINT,
  reduced:  ADVANCE_REDUCED_HINT,
  none:     ADVANCE_NONE_HINT,
}

export const ADVANCE_PERCENT_LABEL = 'Advance percentage'
export const ADVANCE_AMOUNT_LABEL = 'Advance amount *'
/** The same field where it is STATED rather than typed into. No asterisk. */
export const ADVANCE_AMOUNT_READONLY_LABEL = 'Advance amount'
/** The reference figure the standard choice is measured against. */
export const ADVANCE_STANDARD_REFERENCE_LABEL = `Calculated ${ADVANCE_STANDARD_PERCENT}% of grand total`
export const ADVANCE_AMOUNT_PLACEHOLDER = 'e.g. 1014800.00'
export const ADVANCE_REASON_LABEL = 'Reason for exception *'
export const ADVANCE_REASON_PLACEHOLDER =
  'Say what the client has agreed and why the business should accept it…'

/** The fixed figures of the No advance choice. Never computed, never a guess. */
export const ADVANCE_NONE_PERCENT_LABEL = '0%'
export const ADVANCE_NONE_AMOUNT_LABEL = formatInr(0)

/**
 * How an exception whose percentage is unreadable is described.
 *
 * Only reachable for a record written before this screen existed, or one whose
 * percentage column is somehow null. Named rather than inlined so the two
 * screens that can print it cannot word it differently.
 */
export const ADVANCE_EXCEPTION_GENERIC_LABEL = 'Advance exception'

/** What 0% means, stated so nobody has to infer it from an empty figure. */
export const ADVANCE_ZERO_EXPLANATION = 'No advance requested — the order would start with nothing received.'

/**
 * The payment boundary, restated wherever an advance figure appears.
 *
 * previewView.ts already carries ADVANCE_NOT_A_PAYMENT_NOTE for the commercial
 * summary. This is its counterpart for the workflow screens, and it says the
 * same thing for the same reason: an amount on screen beside the word "advance"
 * is read as money received unless the screen says otherwise.
 *
 * IT DOES NOT CLAIM THE AMOUNT HAS BEEN VERIFIED. Nothing in this workflow
 * reaches Finance, checks a receipt or reconciles anything — what is recorded is
 * what the employee DECLARED, and the sentence says exactly that and no more.
 */
export const ADVANCE_NOT_A_PAYMENT =
  'This records the advance amount declared for this PI. Payment verification and linking will be added separately.'

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
  `Submit again declaring at least ${ADVANCE_STANDARD_PERCENT}% of the grand total, or propose a different exception with a new reason.`

// ── The persisted state, as the page reads it ─────────────────────────────────

/** The advance columns of one order_submissions row. */
export type PersistedAdvance = {
  advance_condition: string | null
  /**
   * The AMOUNT the employee declared, in rupees.
   *
   * NULL IS NEVER ZERO. Null means no amount was declared — a record written
   * before this column existed, or one whose grand total was replaced afterwards
   * — and effectiveAdvanceAmount() reads it as whatever the record has always
   * meant. Zero is the "No advance" declaration and is a figure somebody chose.
   */
  advance_declared_amount: number | string | null
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
  'advance_declared_amount',
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

// ── The three derivations, in the browser ────────────────────────────────────
//
// EACH ONE MIRRORS A DATABASE FUNCTION, and must stay a mirror:
//
//   standardAdvanceAmount    order_submission_standard_advance_amount(numeric)
//   derivedAdvancePercent    order_submission_advance_percent_of(numeric, numeric)
//   effectiveAdvanceAmount   order_submission_effective_advance_amount(...)
//
// ALL THREE WORK IN WHOLE PAISE. A rupee figure held as a float cannot be
// compared with another rupee figure and trusted — 0.1 + 0.2 is the standard
// example and money is where it bites. Converting to integer paise once, at the
// edge, is why nothing below has to think about it again.

/** A rupee figure as whole paise. The one place a float becomes an integer. */
function toPaise(rupees: number): number {
  return Math.round(rupees * 100)
}

/**
 * The smallest amount that MEETS the standard requirement, in rupees.
 *
 * CEILING, NOT ROUNDING, and the difference matters. 40% of ₹100.01 is ₹40.004,
 * which is not an amount anybody can pay; rounding gives ₹40.00, which is BELOW
 * the requirement and which the database would then refuse. The ceiling gives
 * ₹40.01 — the smallest real figure that actually satisfies "at least 40%" — so
 * the amount this dialog pre-fills is always one the database will accept.
 *
 * Computed in integer arithmetic (paise × 40 ÷ 100 = paise × 2 ÷ 5) so the
 * ceiling is taken on an exact value rather than on a float a hair either side
 * of one.
 */
export function standardAdvanceAmount(grandTotal: number | null): number | null {
  if (grandTotal === null || !Number.isFinite(grandTotal) || grandTotal < 0) return null
  const numerator = toPaise(grandTotal) * 2
  const paise = Math.floor(numerator / 5) + (numerator % 5 === 0 ? 0 : 1)
  return paise / 100
}

/**
 * The percentage an amount comes to, TRUNCATED to two decimal places.
 *
 * TRUNCATED AND NEVER ROUNDED, for one reason: ₹39,999.99 against a grand total
 * of ₹1,00,000 is 39.99999%, which ROUNDS to 40.00 — a figure that would claim
 * the standard requirement is met by an amount that does not meet it. Truncation
 * cannot overstate.
 *
 * NULL, never a guess, for an absent or non-positive total: a percentage OF
 * nothing is not a number, and 0 ÷ 0 is not 0%.
 */
export function derivedAdvancePercent(
  grandTotal: number | null,
  amount: number | null,
): number | null {
  if (grandTotal === null || amount === null) return null
  if (!Number.isFinite(grandTotal) || !Number.isFinite(amount)) return null
  if (grandTotal <= 0) return null
  return Math.trunc((toPaise(amount) * 10000) / toPaise(grandTotal)) / 100
}

/**
 * The advance a record actually carries, whether or not it stores an amount.
 *
 * THE ONE COMPATIBILITY RULE, IN ONE PLACE, so no screen can word it
 * differently — and the same rule the database applies in
 * order_submission_effective_advance_amount:
 *
 *   an amount is stored          →  that amount, exactly as declared
 *   'standard' with no amount    →  the standard 40% of the current grand total
 *                                   — what the record has always meant
 *   'exception' with no amount   →  the stored percentage of the current grand
 *                                   total — what the record has always meant
 *   nothing declared             →  null
 *
 * ONE FIGURE FOR THE STANDARD CONDITION, EVERYWHERE. The fallback is the same
 * standardAdvanceAmount() the dialog pre-fills and the same one the database
 * measures its constraint against, so a record that stores no amount and one
 * that stores the default cannot print a paisa apart from each other.
 */
export function effectiveAdvanceAmount(
  advance: PersistedAdvance,
  grandTotal: number | null,
): number | null {
  const declared = advanceNumber(advance.advance_declared_amount)
  if (declared !== null) return declared
  const condition = asCondition(advance.advance_condition)
  if (condition === 'standard') return standardAdvanceAmount(grandTotal)
  if (condition === 'exception') {
    return computeAdvanceAmount(grandTotal, advanceNumber(advance.advance_exception_percent))
  }
  return null
}

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
  /**
   * The DECLARED advance in rupees, for every condition — or what the record has
   * always meant, when it stores no amount. An em dash when nothing is declared.
   */
  declaredAmount: string
  /** The declared advance as a number, or null. The figure, not its rendering. */
  declaredAmountValue: number | null
  /** The percentage the declared amount comes to, `40%` / `12.5%`, or null. */
  declaredPercentLabel: string | null
  /** The proposed percentage, when there is an exception. */
  exceptionPercentLabel: string | null
  /** The proposed advance in rupees, derived from the CURRENT grand total. */
  exceptionAmount: string | null
  /** True only for a ₹0 proposal, which needs its meaning spelled out. */
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

  // THE REQUIREMENT ITSELF, taken as the ceiling: the smallest real figure that
  // satisfies "at least 40%", which is what the standard choice is measured
  // against and what the dialog pre-fills.
  const standard = standardAdvanceAmount(grandTotal)
  // THE DECLARED FIGURE, WHEN THERE IS ONE, and what the record has always meant
  // when there is not. One rule, in effectiveAdvanceAmount, mirrored in SQL.
  const declared = effectiveAdvanceAmount(advance, grandTotal)
  const declaredPercent = derivedAdvancePercent(grandTotal, declared)
  const proposed = condition === 'exception' ? declared : null
  // ZERO IS READ OFF THE AMOUNT, not off the percentage. ₹5 against a ₹10,00,000
  // total truncates to 0.00% and is still a real advance somebody declared, so
  // naming it "No advance" would report the opposite of what was asked for.
  const isZero = condition === 'exception' && declared === 0

  return {
    undeclared: condition === null,
    condition,
    // A 0% exception is named for what it IS. "Request advance exception"
    // beside a ₹0 left a reviewer to work out that the two meant "start with
    // nothing", which is the single most consequential thing on the card.
    conditionLabel: condition === 'standard'
      ? ADVANCE_STANDARD_LABEL
      : condition === 'exception'
        ? (declared === null
            ? ADVANCE_EXCEPTION_GENERIC_LABEL
            : isZero ? ADVANCE_NONE_LABEL : ADVANCE_REDUCED_LABEL)
        : null,
    standardPercentLabel: `${ADVANCE_STANDARD_PERCENT}%`,
    standardAmount: standard === null ? '—' : formatInr(standard),
    declaredAmount: declared === null ? '—' : formatInr(declared),
    declaredAmountValue: declared,
    declaredPercentLabel: declaredPercent === null ? null : `${formatPercent(declaredPercent)}%`,
    // THE PERCENTAGE IS DERIVED FROM THE AMOUNT whenever an amount is stored, so
    // the two figures a reviewer reads side by side cannot disagree. The stored
    // column is the fallback for a record written before amounts existed.
    exceptionPercentLabel: condition !== 'exception'
      ? null
      : declaredPercent !== null
        ? `${formatPercent(declaredPercent)}%`
        : percent !== null ? `${formatPercent(percent)}%` : null,
    exceptionAmount: proposed === null ? null : formatInr(proposed),
    isZeroPercent: isZero,
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

/**
 * What is sent. AN AMOUNT, ALWAYS — the percentage is the database's derivation.
 *
 * The `condition` is still the database's word for the route, so 'exception'
 * covers both a reduced advance and no advance at all, exactly as it always has.
 */
export type AdvanceSelection =
  | { condition: 'standard'; amount: number }
  | { condition: 'exception'; amount: number; reason: string }

export type AdvanceValidation =
  | { ok: true; value: AdvanceSelection }
  | { ok: false; message: string }

export const ADVANCE_AMOUNT_REQUIRED = 'Enter the advance amount being declared.'
/**
 * A figure that is not a plain decimal.
 *
 * SEPARATE FROM "out of range", because they are different mistakes and the
 * corrections are different. "1,50,000" and "₹5000" and "1e5" are not too big or
 * too small — they are not amounts this field accepts at all, and telling
 * somebody their comma is out of range would send them to change the wrong thing.
 */
export const ADVANCE_AMOUNT_NOT_A_NUMBER =
  'Enter the amount as plain digits, for example 1014800.50 — no commas, rupee signs, spaces or exponents.'
export const ADVANCE_AMOUNT_TOO_PRECISE =
  `Use at most ${ADVANCE_AMOUNT_MAX_DECIMALS} decimal places — rupees and paise.`
export const ADVANCE_AMOUNT_NEGATIVE = 'The advance amount cannot be negative.'

/** The standard route's two bounds, worded with the figures they compare against. */
export const advanceBelowStandardMessage = (minimum: string): string =>
  `A standard advance must be at least ${minimum}, which is ${ADVANCE_STANDARD_PERCENT}% of the grand total. Select “${ADVANCE_REDUCED_LABEL}” to declare less.`
export const advanceAboveTotalMessage = (total: string): string =>
  `The advance cannot be more than the grand total of ${total}.`
export const advanceNotReducedMessage = (minimum: string): string =>
  `A reduced advance must be below ${minimum}, which is ${ADVANCE_STANDARD_PERCENT}% of the grand total. Select “${ADVANCE_STANDARD_LABEL}” to declare that much or more.`

/**
 * Zero typed into Reduced advance.
 *
 * NOT SILENTLY ACCEPTED AS THE SAME THING. It IS the same declaration in the
 * database, but the two are different decisions to a person and to management,
 * and a screen that quietly turns one into the other is deciding on somebody's
 * behalf. So it points at the choice that says what they mean, by its name.
 */
export const ADVANCE_AMOUNT_ZERO_USE_NONE =
  `₹0 is not a reduced advance. Select “${ADVANCE_NONE_LABEL}” to ask to proceed without an advance.`
export const ADVANCE_REASON_REQUIRED = 'Say why a lower advance is being proposed.'
export const ADVANCE_REASON_TOO_LONG =
  `Please shorten the reason to ${ADVANCE_REASON_MAX_LENGTH} characters or fewer.`
export const ADVANCE_TOTAL_MISSING =
  'This PI has no stored grand total, so an advance cannot be declared against it. Upload a corrected PI with Change PI.'
/**
 * A grand total of zero.
 *
 * Only the standard route survives it — ₹0 of ₹0 is the whole of it — because an
 * exception is a figure BELOW a threshold that is itself zero, and there is no
 * such figure. The database refuses the same case by name.
 */
export const ADVANCE_TOTAL_NOT_POSITIVE =
  'This PI has a grand total of ₹0, so no advance exception can be declared against it.'

/**
 * How many decimal places a typed figure actually carries.
 *
 * READ FROM THE TEXT, not from the parsed number. `Number('1250.50')` is 1250.5
 * and would pass a check written against the value, while "1250.005" and
 * "1250.0050" are genuinely different things to say about what somebody typed.
 * Exponent forms are rejected outright by the shape test below, so this only
 * ever sees a plain decimal.
 */
function decimalPlaces(raw: string): number {
  const dot = raw.indexOf('.')
  return dot < 0 ? 0 : raw.length - dot - 1
}

/** A plain, non-exponential decimal. "1e5", "Infinity", "NaN" and "" are not. */
const PLAIN_DECIMAL = /^\d*\.?\d*$/

/**
 * A typed amount, parsed the way the database parses it — or the refusal.
 *
 * ORDERED, and the order is the message somebody gets: shape before value, value
 * before precision. A "1,50,000" is answered as a malformed figure rather than as
 * 1 being below the minimum, because the second sentence would send them to fix
 * something that is not wrong.
 */
type AmountParse = { ok: true; amount: number } | { ok: false; message: string }

function parseDeclaredAmount(amountText: string): AmountParse {
  const raw = amountText.trim()
  if (raw === '' || raw === '.') return { ok: false, message: ADVANCE_AMOUNT_REQUIRED }

  // A leading minus never reaches PLAIN_DECIMAL, so a genuine negative FIGURE is
  // named here rather than being answered as "malformed": "-5000" is a number, it
  // is simply not an advance anybody may declare. "-Infinity" and "-abc" are not
  // figures at all and fall through to the shape test below.
  if (raw.startsWith('-') && PLAIN_DECIMAL.test(raw.slice(1)) && raw.slice(1) !== '') {
    return { ok: false, message: ADVANCE_AMOUNT_NEGATIVE }
  }
  if (!PLAIN_DECIMAL.test(raw)) return { ok: false, message: ADVANCE_AMOUNT_NOT_A_NUMBER }

  const amount = Number(raw)
  // Unreachable through PLAIN_DECIMAL — "NaN", "Infinity" and "1e5" are all
  // refused by the shape test above — and kept anyway, because a value that is
  // not a finite number must never leave this function as one.
  if (!Number.isFinite(amount)) return { ok: false, message: ADVANCE_AMOUNT_NOT_A_NUMBER }

  if (decimalPlaces(raw) > ADVANCE_AMOUNT_MAX_DECIMALS) {
    return { ok: false, message: ADVANCE_AMOUNT_TOO_PRECISE }
  }
  return { ok: true, amount }
}

/** The reason, trimmed, or the refusal. Shared by both exception choices. */
function parseExceptionReason(reason: string): { ok: true; reason: string } | { ok: false; message: string } {
  const trimmed = reason.trim()
  if (trimmed === '') return { ok: false, message: ADVANCE_REASON_REQUIRED }
  if (trimmed.length > ADVANCE_REASON_MAX_LENGTH) return { ok: false, message: ADVANCE_REASON_TOO_LONG }
  return { ok: true, reason: trimmed }
}

/**
 * The employee's declaration, as it will be sent — or the reason it cannot be.
 *
 * VALIDATED THE WAY THE DATABASE VALIDATES IT, and in the same order, so what the
 * dialog refuses is what the RPC would have refused. Every rule here is
 * re-derived in submit_order_submission_advance_v2_internal, which is the one
 * that decides; this exists so somebody is told while they type rather than after
 * a round trip.
 *
 * THE CLASSIFICATION IS THE AMOUNT AGAINST standardAdvanceAmount(), NEVER a
 * rounded percentage. ₹39,999.99 of ₹1,00,000 displays as 39.99% and would
 * display as 40% if it were rounded; it is a reduced advance either way, because
 * the amount is a paisa short of the requirement and the amount is what decides.
 *
 * THE ONE RULE THAT IS STRICTER HERE THAN IN THE DATABASE is zero under Reduced
 * advance. The RPC accepts a ₹0 exception from either choice because it cannot
 * see which radio was pressed — and it should not, since ₹0 is a legitimate
 * declaration. What the SCREEN refuses is the ambiguity: somebody who typed 0
 * into "Reduced advance" is told to press the choice that says what they mean,
 * so the record and the person agree about what was asked for. Nothing is
 * rounded, coerced or silently reinterpreted.
 *
 * A MISSING GRAND TOTAL FAILS CLOSED, for every choice. The employee must not be
 * allowed to declare an advance against an amount nobody knows — 40% of an
 * unknown is not a figure, and neither is ₹0 of one.
 */
export function validateAdvanceDeclaration(input: {
  choice: AdvanceChoice
  /** Exactly what is in the amount box. Never a pre-parsed number. */
  amountText: string
  reason: string
  /** The PERSISTED grand total. Null means the workbook printed no figure. */
  grandTotal: number | null
}): AdvanceValidation {
  if (input.grandTotal === null || !Number.isFinite(input.grandTotal)) {
    return { ok: false, message: ADVANCE_TOTAL_MISSING }
  }
  const minimum = standardAdvanceAmount(input.grandTotal)
  if (minimum === null) return { ok: false, message: ADVANCE_TOTAL_MISSING }

  // No advance carries no typed amount at all: the figure IS the choice. Whatever
  // is sitting in the box from a moment spent on another option is not read, so
  // it cannot contradict the declaration being made.
  if (input.choice === 'none') {
    if (input.grandTotal <= 0) return { ok: false, message: ADVANCE_TOTAL_NOT_POSITIVE }
    const reason = parseExceptionReason(input.reason)
    if (!reason.ok) return { ok: false, message: reason.message }
    return { ok: true, value: { condition: 'exception', amount: 0, reason: reason.reason } }
  }

  const parsed = parseDeclaredAmount(input.amountText)
  if (!parsed.ok) return { ok: false, message: parsed.message }

  if (parsed.amount > input.grandTotal) {
    return { ok: false, message: advanceAboveTotalMessage(formatInr(input.grandTotal)) }
  }

  if (input.choice === 'standard') {
    if (parsed.amount < minimum) {
      return { ok: false, message: advanceBelowStandardMessage(formatInr(minimum)) }
    }
    return { ok: true, value: { condition: 'standard', amount: parsed.amount } }
  }

  if (input.grandTotal <= 0) return { ok: false, message: ADVANCE_TOTAL_NOT_POSITIVE }
  if (parsed.amount === 0) return { ok: false, message: ADVANCE_AMOUNT_ZERO_USE_NONE }
  if (parsed.amount >= minimum) {
    return { ok: false, message: advanceNotReducedMessage(formatInr(minimum)) }
  }

  const reason = parseExceptionReason(input.reason)
  if (!reason.ok) return { ok: false, message: reason.message }

  return { ok: true, value: { condition: 'exception', amount: parsed.amount, reason: reason.reason } }
}

/**
 * An amount as it belongs in the box: plain digits, at most two decimals.
 *
 * NOT formatInr. The box is a field somebody types into and the parser refuses
 * grouping separators and currency signs, so pre-filling it with "₹10,14,800.00"
 * would pre-fill it with something the same screen calls malformed.
 */
export function advanceAmountText(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return ''
  return String(Number(amount.toFixed(ADVANCE_AMOUNT_MAX_DECIMALS)))
}

/**
 * The choice the dialog opens on, for this record.
 *
 * A NEW SUBMISSION DEFAULTS TO STANDARD, PRE-FILLED WITH THE EXACT 40% AMOUNT,
 * which is the ordinary path and the one the business prefers — and it is the
 * default ONLY for a PI that has never declared anything. A RESUBMISSION OPENS ON
 * WHATEVER THE RECORD ALREADY SAYS, so a PI returned for an unrelated correction
 * does not silently switch the employee's advance out from under them while they
 * fix a fabric name — and an approved exception resubmitted unchanged stays
 * approved rather than going back for a second decision.
 *
 * THE BOX OPENS ON THE AMOUNT THE RECORD CARRIES, which for a record written
 * before amounts existed is the figure it has always meant: 40% of the grand
 * total under the standard condition, or the stored percentage of it under an
 * exception. So an old PI resubmitted without touching the box declares exactly
 * what it already declared.
 *
 * A STORED ₹0 OPENS ON "No advance", not on "Reduced advance" with a zero in the
 * box. The record says the order would start with nothing received; the dialog
 * must say the same thing back, or resubmitting an approved ₹0 exception would
 * fail the screen's own zero rule.
 */
export function initialAdvanceSelection(
  advance: PersistedAdvance,
  grandTotal: number | null,
): AdvanceDeclaration {
  const declared = effectiveAdvanceAmount(advance, grandTotal)

  if (asCondition(advance.advance_condition) === 'exception') {
    const reason = (advance.advance_exception_reason ?? '').trim()
    if (declared === 0) return { choice: 'none', amountText: '', reason }
    return { choice: 'reduced', amountText: advanceAmountText(declared), reason }
  }

  return {
    choice: 'standard',
    // A declared standard amount is offered back verbatim; anything else opens on
    // the exact 40% figure, taken as the ceiling so the default is never a paisa
    // short of the requirement it is offered to satisfy.
    amountText: advanceAmountText(
      asCondition(advance.advance_condition) === 'standard' && declared !== null
        ? declared
        : standardAdvanceAmount(grandTotal),
    ),
    reason: '',
  }
}

/**
 * The declaration after the employee presses a different choice.
 *
 * VALUES THAT DO NOT BELONG TO THE NEW CHOICE ARE CLEARED, and that is the point:
 * an amount typed as a reduced advance is not the same statement when the choice
 * becomes "40% or above", and a reason written for an exception has no meaning at
 * all once the standard route is selected. Leaving either behind would let a
 * stale figure or a stale sentence ride along with a declaration nobody attached
 * it to.
 *
 *   → standard   the box resets to the exact 40% amount, and the reason is gone
 *   → reduced    the box empties — the standard figure is by definition not a
 *                reduced one — and the reason survives, because it is the same
 *                exception request being reshaped
 *   → none       the box is irrelevant and the reason survives, for the same
 *                reason
 *
 * The validation message follows automatically: it is recomputed from this, so
 * an error about the previous choice cannot outlive it.
 */
export function advanceChoiceChange(
  current: AdvanceDeclaration,
  next: AdvanceChoice,
  grandTotal: number | null,
): AdvanceDeclaration {
  if (next === current.choice) return current
  if (next === 'standard') {
    return {
      choice: 'standard',
      amountText: advanceAmountText(standardAdvanceAmount(grandTotal)),
      reason: '',
    }
  }
  return { choice: next, amountText: '', reason: current.reason }
}

/**
 * Whether the employee has typed nothing yet under a choice that needs input.
 *
 * Somebody who has just pressed "Reduced advance" has not made a mistake — they
 * have not typed anything — and greeting them with a red sentence about an amount
 * they were about to enter is scolding, not help. Submit stays disabled
 * throughout, so nothing invalid can be sent while this is true.
 *
 * "No advance" needs only a reason, so an untouched one is a blank reason. The
 * standard choice is NEVER untouched: it opens pre-filled with a valid figure, so
 * an empty box there is somebody having deleted one.
 */
export function advanceDeclarationUntouched(declaration: AdvanceDeclaration): boolean {
  if (declaration.choice === 'standard') return false
  if (declaration.choice === 'none') return declaration.reason.trim() === ''
  return declaration.amountText.trim() === '' && declaration.reason.trim() === ''
}

/**
 * The live percentage beside the amount box.
 *
 * Returns an em dash rather than 0% for an unusable input, so a half-typed "12."
 * shows nothing instead of flashing a figure nobody declared. TRUNCATED, like
 * every other derivation, so the figure on screen can never claim the standard
 * requirement is met by an amount that does not meet it.
 */
export function previewAdvancePercent(
  amountText: string,
  grandTotal: number | null,
): string {
  const parsed = parseDeclaredAmount(amountText)
  if (!parsed.ok) return '—'
  const percent = derivedAdvancePercent(grandTotal, parsed.amount)
  return percent === null ? '—' : `${formatPercent(percent)}%`
}
