// The Lead card (20270811000000): which one thing a quotation offers to do on its lead, and the words it writes there.
// Pure, so every rule is tested without a screen. The writes themselves are the lead's own functions (add_sales_lead_comment,
// move_sales_lead), called by the card: nothing here moves a lead.

import type { QuotationEvent, QuotationStatus } from './api'

export type LeadAction = 'log' | 'convert' | 'dead'

/** A sent quotation is followed up in this many days (owner's plan, 19 Nov 2026); the person may pick another day. */
export const FOLLOW_UP_DAYS = 3

/** The one button a quotation offers, from where it is. Nothing for a draft or an archived quotation, nor on a lead that is already closed. */
export function leadAction(status: QuotationStatus, leadStage: string): LeadAction | null {
  if (leadStage === 'converted' || leadStage === 'dead') return null
  if (status === 'sent' || status === 'negotiating') return 'log'
  if (status === 'confirmed') return 'convert'
  if (status === 'lost') return 'dead'
  return null
}

/** The follow-up the card proposes: FOLLOW_UP_DAYS after today (an India date, YYYY-MM-DD), and a Sunday becomes the Monday. */
export function followUpDefault(today: string, days = FOLLOW_UP_DAYS): string {
  const [y, m, d] = today.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  if (t.getUTCDay() === 0) t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}

/** What is written on the lead. It names the quotation by its number, which is how "logged" is recognised afterwards. */
export function logNote(quoteNo: string, versionNo: number | null, value: number): string {
  const v = versionNo ? ` v${versionNo}` : ''
  return `${quoteNo}${v} sent to the client, ₹${Math.round(value).toLocaleString('en-IN')} before GST`
}

/** Why the quotation was lost, as written when it was marked Lost (the newest such entry), or ''. */
export function lostNote(events: readonly QuotationEvent[]): string {
  const e = events.find(x => x.kind === 'status' && x.detail.to === 'lost')
  const n = e?.detail.note
  return typeof n === 'string' ? n : ''
}
