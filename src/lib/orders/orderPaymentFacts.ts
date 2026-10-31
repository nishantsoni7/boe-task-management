// ── THE PAYMENT CARD'S SUPPORTING FACTS (owner, 2026-10-27) ──────────────────
//
// The Payment card is drawn beside Documents and used to leave a tall empty
// space under its Balance line. These are the facts a reader asks next, all
// read from data the page already holds (the finance position and the 40%
// advance readiness) — no new query and no new rule:
//
//   Order value (incl. GST)   what is owed in all
//   Advance (40% of Total before GST)   what the rule requires, and whether it is met
//
// Last verified payment and Verified by mode were here too, and were removed
// to make the card shorter (owner, 2026-10-31); the Verified box opens the list.
//
// A fact with nothing to say is left out, never drawn as a dash.

import type { AdvanceReadiness } from './advanceReadiness'

export type PaymentFactTone = 'neutral' | 'green' | 'amber'

export type PaymentFact = {
  key: 'order_value' | 'advance'
  label: string
  value: string
  /** A quiet second line, or null. */
  detail: string | null
  tone: PaymentFactTone
}

const paise = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

export function orderPaymentFacts(input: {
  /** The Order's value, GST included, as the finance position states it. */
  orderValue: string | null
  advance: AdvanceReadiness | null
  formatMoney: (amount: string | number | null) => string
}): PaymentFact[] {
  const { orderValue, advance, formatMoney } = input
  const facts: PaymentFact[] = []

  if (orderValue !== null && paise(orderValue) > 0) {
    facts.push({ key: 'order_value', label: 'Order value (incl. GST)', value: formatMoney(orderValue), detail: null, tone: 'neutral' })
  }

  if (advance && advance.required !== null && advance.value_known !== false) {
    const threshold = Number(advance.threshold_percent)
    const label = `Advance (${Number.isFinite(threshold) ? threshold : 40}% of Total before GST)`
    const required = formatMoney(advance.required)
    if (advance.exception) {
      facts.push({ key: 'advance', label, value: required, detail: 'Approved below the requirement by an administrator', tone: 'amber' })
    } else if (advance.below) {
      facts.push({
        key: 'advance', label, value: required,
        detail: advance.shortfall !== null ? `${formatMoney(advance.shortfall)} short of the requirement` : 'Below the requirement',
        tone: 'amber',
      })
    } else {
      facts.push({ key: 'advance', label, value: required, detail: 'Requirement met', tone: 'green' })
    }
  }

  return facts
}
