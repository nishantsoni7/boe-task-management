// ── The Payment plan screen's own words ─────────────────────────────────────
//
// Plain-text pieces only the SCREEN draws (owner, 2026-10-30, layout B): the
// rates line under each product name, the message under a wrong "This lot"
// quantity, the help under each Plan settings box and the lot's piece count.
// Excel and PDF keep the full sheet (paymentPlanSheet.ts) and use none of this.
// Pure, so it is tested on its own; every figure still comes from
// computePaymentPlan.

import type { PlanLineResult } from './paymentPlan'
import { wholeRupees } from './paymentPlanSheet'

const rupeesText = (rupees: number) => `₹${wholeRupees(Math.round(rupees * 100))}`
const qtyText = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('en-IN')

/** Paise as "₹2,93,693", or "−₹500" below zero. */
export const moneyText = (paise: number) => (paise < 0 ? `−₹${wholeRupees(-paise)}` : `₹${wholeRupees(paise)}`)

/** A balance: below zero the client has paid more than needed. */
export const balanceText = (paise: number) => (paise < 0 ? `₹${wholeRupees(-paise)} paid extra` : `₹${wholeRupees(paise)}`)

/** "₹5,650 / pc · packing ₹550 · fabric 0.45 m × ₹750": the rates the line's amounts come from. */
export function lineRatesText(
  line: Pick<PlanLineResult, 'rate' | 'packingRate' | 'fabricMetresPerPiece' | 'fabricRate'>,
): string {
  const parts = [`${rupeesText(line.rate)} / pc`]
  if (line.packingRate !== null && line.packingRate > 0) parts.push(`packing ${rupeesText(line.packingRate)}`)
  if (line.fabricMetresPerPiece !== null && line.fabricMetresPerPiece > 0) {
    parts.push(line.fabricRate !== null && line.fabricRate > 0
      ? `fabric ${qtyText(line.fabricMetresPerPiece)} m × ${rupeesText(line.fabricRate)}`
      : `fabric ${qtyText(line.fabricMetresPerPiece)} m, no rate`)
  }
  return parts.join(' · ')
}

/** What is wrong with a typed "This lot" quantity, in words, or null when nothing is. */
export function lotQuantityProblem(
  line: Pick<PlanLineResult, 'ordered' | 'previouslyDispatched' | 'planned' | 'remaining'>,
  typedInvalid: boolean,
): string | null {
  if (typedInvalid) return 'Type a number, with at most two decimals.'
  if (line.planned <= 0 || line.remaining >= 0) return null
  const left = line.ordered - line.previouslyDispatched
  if (left <= 0) return 'Nothing is left to send on this line.'
  return `Only ${qtyText(left)} left to send. Lower it to ${qtyText(left)} or less.`
}

/** "0 of 65 pieces planned": this lot against everything not yet sent. */
export function lotPiecesText(lines: readonly Pick<PlanLineResult, 'ordered' | 'previouslyDispatched' | 'planned'>[]): string {
  const planned = lines.reduce((s, l) => s + l.planned, 0)
  const left = lines.reduce((s, l) => s + Math.max(0, l.ordered - l.previouslyDispatched), 0)
  return `${qtyText(planned)} of ${qtyText(left)} pieces planned`
}

export const ADVANCE_HELP = 'The share of the goods still to come that is paid before this dispatch.'

export function billingHelp(piBillingPercent: number | null): string {
  return piBillingPercent === null
    ? 'The PI has none. Leave blank to count everything as cash.'
    : `Leave blank to use the PI's ${piBillingPercent}%.`
}

/** Help under a "Received" box: what a blank box uses. `confirmedRupees` is Finance's verified total. */
export function receivedHelp(confirmedRupees: number): string {
  return `Leave blank to use confirmed payments: ${rupeesText(confirmedRupees)}`
}

export const PERCENT_PROBLEM = 'Type a number from 0 to 100, with at most two decimals.'
export const AMOUNT_PROBLEM = 'Type an amount in rupees, with at most two decimals.'
