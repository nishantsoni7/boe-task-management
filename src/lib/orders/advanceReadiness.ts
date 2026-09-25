// ── THE 40% ADVANCE, MEASURED ON THE ORDER'S AMENDED VALUE (20270104000000) ───
//
// A revised PI is in force at the admin's approval and the Order's value moves
// with it. The verified advance is then measured against the NEW value; while
// it is short, production cannot be aligned (the database refuses it:
// orders_alignment_requires_advance) until more payment is verified or an
// administrator approves production below 40% for that value
// (approve_order_advance_exception). This file only puts that position into
// words; order_advance_readiness() is what the screen reads.

export type AdvanceReadiness = {
  order_value: number | string | null
  verified: number | string
  awaiting: number | string
  required: number | string | null
  shortfall: number | string
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
export function advanceGateView(r: AdvanceReadiness | null, input: { versionNumber: number | null; approverName?: string | null; formatWhen?: (iso: string | null) => string }): AdvanceGateView {
  if (!r || !r.below) return { kind: 'none' }
  const threshold = percentText(r.threshold_percent)
  const figures = `${percentText(r.percent)} verified — ${rupees(r.verified)} of the Order value ${rupees(r.order_value)}.`
  if (r.ready && r.exception) {
    const who = input.approverName ?? 'an administrator'
    const when = input.formatWhen && r.exception.approved_at ? ` on ${input.formatWhen(r.exception.approved_at)}` : ''
    return {
      kind: 'excepted',
      headline: `Production approved below ${threshold} advance`,
      figures,
      note: r.exception.source === 'pi'
        ? `The PI's own below-${threshold} approval still covers this value.`
        : `Approved by ${who}${when}${r.exception.reason ? `: ${r.exception.reason}` : ''}. A change to the Order's value needs a new approval.`,
    }
  }
  const version = input.versionNumber ? `PI V${input.versionNumber}` : 'this PI'
  return {
    kind: 'blocked',
    headline: `Advance below ${threshold} — production cannot be aligned`,
    figures,
    shortfall: `${rupees(r.shortfall)} more verified payment is needed.`,
    awaiting: num(r.awaiting) > 0 ? `${rupees(r.awaiting)} is awaiting Finance verification and does not count yet.` : null,
    action: `Operations can accept ${version} for production once Finance verifies the payment, or an administrator approves production below ${threshold}.`,
  }
}

/**
 * The attention-strip line, or null. The CONSEQUENCE, not the figures: payment
 * is stated in one place on the Order page, the Payment section, where the
 * panel gives the percentage and the shortfall.
 */
export function advanceAttentionLabel(r: AdvanceReadiness | null): string | null {
  if (!r || !r.below || r.ready) return null
  return `Production blocked: advance below ${percentText(r.threshold_percent)} — see Payment`
}

/** The database's refusal, in the words a person reads. */
export function describeAdvanceRefusal(message: string | null | undefined): string | null {
  const m = message ?? ''
  const at = m.indexOf('ORDER_ADVANCE_BELOW_THRESHOLD: ')
  if (at >= 0) return m.slice(at + 'ORDER_ADVANCE_BELOW_THRESHOLD: '.length)
  if (m.includes('ORDER_ADVANCE_EXCEPTION_REASON_REQUIRED')) return 'Say why production may go ahead below the 40% advance (at least 10 characters).'
  if (m.includes('ORDER_ADVANCE_EXCEPTION_NOT_NEEDED')) return 'The 40% advance is already verified; no approval is needed.'
  if (m.includes('ORDER_ADVANCE_EXCEPTION_ALREADY_APPROVED')) return 'Production below 40% is already approved for this Order value.'
  if (m.includes('Only an administrator can approve production below')) return 'Only an administrator can approve production below the 40% advance.'
  return null
}
