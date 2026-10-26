// ── THE PAYMENT CARD'S SUPPORTING FACTS (owner, 2026-10-27) ──────────────────
//
// The Payment card is drawn beside Documents and used to leave a tall empty
// space under its Balance line. These are the facts a reader asks next, all
// read from data the page already holds (the payment rows and the 40% advance
// readiness) — no new query and no new rule:
//
//   Order value (incl. GST)   what is owed in all
//   Advance (40% of Total before GST)   what the rule requires, and whether it is met
//   Last verified payment     the newest verified one: amount, date, mode
//   Verified by mode          how the verified money arrived
//
// A fact with nothing to say is left out, never drawn as a dash.

import { isVerifiedPaymentStatus } from './orderPayments'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'
import type { AdvanceReadiness } from './advanceReadiness'

export type PaymentFactTone = 'neutral' | 'green' | 'amber'

export type PaymentFact = {
  key: 'order_value' | 'advance' | 'last_verified' | 'modes'
  label: string
  value: string
  /** A quiet second line, or null. */
  detail: string | null
  tone: PaymentFactTone
}

/** The slice of a payment row these facts read. */
export type PaymentFactRow = {
  status: string
  payment_date: string | null
  payment_mode: string | null
  exactAllocatedAmount: string
}

const paise = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

const modeLabel = (mode: string | null) => paymentModeLabel(mode)

export function orderPaymentFacts(input: {
  rows: readonly PaymentFactRow[]
  /** The Order's value, GST included, as the finance position states it. */
  orderValue: string | null
  advance: AdvanceReadiness | null
  formatMoney: (amount: string | number | null) => string
  formatDate: (iso: string | null) => string
}): PaymentFact[] {
  const { rows, orderValue, advance, formatMoney, formatDate } = input
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

  const verified = rows.filter(r => isVerifiedPaymentStatus(r.status))
  if (verified.length > 0) {
    const latest = [...verified].sort((a, b) => (b.payment_date ?? '').localeCompare(a.payment_date ?? ''))[0]
    facts.push({
      key: 'last_verified',
      label: 'Last verified payment',
      value: formatMoney(latest.exactAllocatedAmount),
      detail: [latest.payment_date ? formatDate(latest.payment_date) : null, modeLabel(latest.payment_mode)].filter(Boolean).join(' · '),
      tone: 'neutral',
    })

    const byMode = new Map<string, number>()
    for (const r of verified) byMode.set(modeLabel(r.payment_mode), (byMode.get(modeLabel(r.payment_mode)) ?? 0) + paise(r.exactAllocatedAmount))
    const parts = [...byMode.entries()].sort((a, b) => b[1] - a[1])
    facts.push({
      key: 'modes',
      label: 'Verified by mode',
      value: parts.map(([mode, p]) => `${mode} ${formatMoney((p / 100).toFixed(2))}`).join(' · '),
      detail: null,
      tone: 'neutral',
    })
  }

  return facts
}
