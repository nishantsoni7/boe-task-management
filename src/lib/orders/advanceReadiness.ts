// ── THE 40% ADVANCE, MEASURED ON THE ORDER'S AMENDED VALUE (20270116000000) ───
//
// A revised PI is in force at the admin's approval and the Order's value moves
// with it. The verified advance is then measured against the NEW value; while
// it is short, production cannot be aligned (the database refuses it:
// orders_alignment_requires_advance) until more payment is verified or an
// administrator approves production below 40% for that value
// (approve_order_advance_exception). An ALIGNED Order that falls short later —
// its value raised, its verified money reduced — loses the alignment at once
// and carries a HOLD until it is aligned again; an Order with no value on
// record is never ready on payment. This file only puts that position into
// words; order_advance_readiness() is what the screen reads.

export type AdvanceHoldCause = 'value_changed' | 'pi_revision' | 'payment_changed'

export type AdvanceHold = {
  id: string
  cause: AdvanceHoldCause | string
  held_at: string | null
  order_value: number | string | null
  previous_order_value: number | string | null
  verified: number | string
  percent: number | string | null
  shortfall: number | string | null
}

export type AdvanceReadiness = {
  order_value: number | string | null
  /** False for NULL, zero or NaN: nothing to measure the advance against. */
  value_known?: boolean
  verified: number | string
  awaiting: number | string
  required: number | string | null
  shortfall: number | string | null
  percent: number | string | null
  threshold_percent: number | string
  below: boolean
  ready: boolean
  exception: {
    source: 'order' | 'pi'
    approved_by: string | null
    approved_at: string | null
    reason?: string | null
    order_value?: number | string | null
  } | null
  /** Readiness removed from an aligned Order that fell short; open until it is aligned again. */
  hold?: AdvanceHold | null
  /**
   * While a hold is open: who may align the Order again (review R1). The
   * current operations reviewer when one can act; otherwise an administrator's
   * recorded recovery. For drawing only — the doors decide again under lock.
   */
  realign?: {
    reviewer_id: string | null
    reviewer_available: boolean
    by_viewer: boolean
    recover_by_viewer: boolean
  } | null
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : 0)

export const rupees = (v: unknown): string =>
  `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const percentText = (v: unknown): string =>
  `${num(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`

export const ADVANCE_EXCEPTION_ACTION = 'Approve production below 40%…'

export type AdvanceGateView =
  | { kind: 'none' }
  | {
      kind: 'blocked'
      headline: string
      /** Why readiness was removed, when an aligned Order fell short. */
      hold: string | null
      figures: string
      shortfall: string
      awaiting: string | null
      action: string
    }
  | { kind: 'excepted'; headline: string; figures: string; note: string }

/**
 * What the Order page says about the advance. Nothing while the verified
 * advance meets 40% of the Order's value; a blocking panel while it is short;
 * a quiet note once an administrator has approved production below 40%.
 */
/**
 * Which way a value moved: 'raised', 'lowered', or 'changed' when either figure
 * is unknown or they are equal. A LOWER value can put an Order on hold too — an
 * approval given for the old value no longer covers it (review R2). SQL twin:
 * order_value_change_word().
 */
export function valueChangeWord(before: unknown, after: unknown): 'raised' | 'lowered' | 'changed' {
  const known = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v))
  if (!known(before) || !known(after)) return 'changed'
  const a = Number(before), b = Number(after)
  return b > a ? 'raised' : b < a ? 'lowered' : 'changed'
}

/** Why a hold opened, in words that match what happened to the value. */
export function holdCauseText(cause: unknown, previous: unknown, current: unknown): string {
  const dir = valueChangeWord(previous, current)
  if (cause === 'value_changed') return dir === 'changed' ? "the Order's value changed" : `the Order's value was ${dir}`
  if (cause === 'pi_revision') return `a revised PI ${dir} the Order's value`
  if (cause === 'payment_changed') return 'verified payment against it was reduced'
  return 'the Order changed'
}

/** The hold, in one sentence: when, why, and where it left the advance. */
export function advanceHoldSentence(h: AdvanceHold | null | undefined, formatWhen?: (iso: string | null) => string): string | null {
  if (!h) return null
  const when = formatWhen && h.held_at ? ` on ${formatWhen(h.held_at)}` : ''
  const why = holdCauseText(h.cause, h.previous_order_value, h.order_value)
  const where = h.percent == null
    ? 'no Order value is on record to measure the advance against'
    : `the verified advance fell to ${percentText(h.percent)} of ${rupees(h.order_value)}`
  return `Production readiness was removed${when} because ${why}: ${where}.`
}

export function advanceGateView(r: AdvanceReadiness | null, input: { versionNumber: number | null; approverName?: string | null; formatWhen?: (iso: string | null) => string }): AdvanceGateView {
  if (!r || !r.below) return { kind: 'none' }
  const threshold = percentText(r.threshold_percent)
  const valueKnown = r.value_known !== false
  const figures = valueKnown
    ? `${percentText(r.percent)} verified — ${rupees(r.verified)} of the Order value ${rupees(r.order_value)}.`
    : `No Order value is on record, so the advance cannot be measured (${rupees(r.verified)} verified).`
  if (r.ready && r.exception) {
    const who = input.approverName ?? 'an administrator'
    const when = input.formatWhen && r.exception.approved_at ? ` on ${input.formatWhen(r.exception.approved_at)}` : ''
    return {
      kind: 'excepted',
      headline: `Production approved below ${threshold} advance`,
      figures,
      note: r.exception.source === 'pi'
        ? `The PI's own below-${threshold} approval still covers this value.`
        : `Approved by ${who}${when}${r.exception.reason ? `: ${r.exception.reason}` : ''}. A change to the Order's value, a new PI version, or less verified payment needs a new approval.`,
    }
  }
  const version = input.versionNumber ? `PI V${input.versionNumber}` : 'this PI'
  const held = !!r.hold
  return {
    kind: 'blocked',
    headline: held
      ? `Production on hold — advance below ${threshold}`
      : `Advance below ${threshold} — production cannot be aligned`,
    hold: advanceHoldSentence(r.hold, input.formatWhen),
    figures,
    shortfall: valueKnown
      ? `${rupees(r.shortfall)} more verified payment is needed.`
      : `An administrator's below-${threshold} approval is needed.`,
    awaiting: num(r.awaiting) > 0 ? `${rupees(r.awaiting)} is awaiting Finance verification and does not count yet.` : null,
    action: held
      ? `Operations can align production again against ${version} once Finance verifies the payment, or an administrator approves production below ${threshold}.`
      : `Operations can accept ${version} for production once Finance verifies the payment, or an administrator approves production below ${threshold}.`,
  }
}

/**
 * A held Order that is ready again (review W3): the strip says so, amber, so
 * the reviewer knows why "Align production again" is offered. Null otherwise —
 * and never a reason to disable anything.
 */
export function advanceRealignLabel(r: AdvanceReadiness | null): string | null {
  if (!r || !r.hold || !r.ready) return null
  return 'Production on hold — the advance is covered again; align production again'
}

/**
 * The attention-strip line, or null. The CONSEQUENCE, not the figures: payment
 * is stated in one place on the Order page, the Payment section, where the
 * panel gives the percentage and the shortfall.
 */
export function advanceAttentionLabel(r: AdvanceReadiness | null): string | null {
  if (!r || !r.below || r.ready) return null
  if (r.hold) return `Production on hold: advance below ${percentText(r.threshold_percent)} — see Payment`
  return `Production blocked: advance below ${percentText(r.threshold_percent)} — see Payment`
}

/** The database's refusal, in the words a person reads. */
export function describeAdvanceRefusal(message: string | null | undefined): string | null {
  const m = message ?? ''
  const at = m.indexOf('ORDER_ADVANCE_BELOW_THRESHOLD: ')
  if (at >= 0) return m.slice(at + 'ORDER_ADVANCE_BELOW_THRESHOLD: '.length)
  const unknown = m.indexOf('ORDER_ADVANCE_VALUE_UNKNOWN: ')
  if (unknown >= 0) return m.slice(unknown + 'ORDER_ADVANCE_VALUE_UNKNOWN: '.length)
  if (m.includes('ORDER_ADVANCE_EXCEPTION_REASON_REQUIRED')) return 'Say why production may go ahead below the 40% advance (at least 10 characters).'
  if (m.includes('ORDER_ADVANCE_EXCEPTION_NOT_NEEDED')) return 'The 40% advance is already verified; no approval is needed.'
  if (m.includes('ORDER_ADVANCE_EXCEPTION_ALREADY_APPROVED')) return 'Production below 40% is already approved for this Order value and PI version.'
  if (m.includes('ORDER_ADVANCE_EXCEPTION_REASON_TOO_LONG')) return 'The reason may be at most 1000 characters.'
  if (m.includes('Only an administrator can approve production below')) return 'Only an administrator can approve production below the 40% advance.'
  return null
}
