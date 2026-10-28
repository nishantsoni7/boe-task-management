// ── The Payment plan as a document ────────────────────────────────────────────
//
// ONE model that the screen's summary, the Excel and the PDF all draw, so a
// download can never say something the screen does not. It decides nothing:
// every figure comes from computePaymentPlan, and this only arranges them into
// labelled rows in plain words a client can follow (owner, 2026-10-29).

import {
  formatPaise,
  rupees,
  type PlanData,
  type PlanResult,
} from './paymentPlan'

export type SheetCell = string | number | null
export type SheetColumn = { label: string; kind: 'text' | 'qty' | 'money' }

/** One row of the Account / Cash / Total summary. Amounts in paise; null = nothing on that side. */
export type SummaryRow = {
  label: string
  account: number | null
  cash: number | null
  total: number | null
  kind: 'line' | 'total' | 'balance'
}

export type PaymentPlanSheet = {
  title: string
  facts: { label: string; value: string }[]
  lineColumns: SheetColumn[]
  lineRows: SheetCell[][]
  lineTotals: SheetCell[]
  lotColumns: SheetColumn[]
  lotRows: SheetCell[][]
  summary: SummaryRow[]
  notes: string[]
}

const dateText = (iso: string | null) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}-${m}-${y}` : iso
}

const pct = (n: number) => `${(Math.round(n * 100) / 100).toString()}%`
export const gstRateText = (rate: number) => pct(rate * 100)

/** The summary in plain words: what is due, what has come in, what is left — account and cash apart. */
export function planSummaryRows(result: PlanResult): SummaryRow[] {
  const s = result.split
  const row = (label: string, side: { account: number; cash: number; total: number }, kind: SummaryRow['kind'] = 'line'): SummaryRow =>
    ({ label, account: side.account, cash: side.cash, total: side.total, kind })
  const rows: SummaryRow[] = [
    row('Goods being sent, with their share of fabric, packing and transport', s.dispatch),
    row(`Advance for goods still to come (${pct(result.pendingPercent)})`, s.pending),
    { label: `GST ${gstRateText(result.gstRate)} on the billed part`, account: s.gst.account, cash: null, total: s.gst.total, kind: 'line' },
    row('Total to be paid', s.due, 'total'),
    row('Already received', s.received),
  ]
  const m = s.movedFromAccount
  if (m.excessPaise > 0) {
    rows.push({
      label: `Extra paid in account, billed as goods ${formatPaise(m.goodsPaise)} + GST ${formatPaise(m.gstPaise)}`,
      account: m.excessPaise,
      cash: -m.goodsPaise,
      total: m.excessPaise - m.goodsPaise,
      kind: 'line',
    })
  }
  rows.push(row('Balance to pay', s.balance, 'balance'))
  return rows
}

export function buildPaymentPlanSheet(
  data: PlanData,
  result: PlanResult,
  extra: { lotLines: Record<string, number>; generatedOn: string; plannedOn: string | null },
): PaymentPlanSheet {
  const rateOf = new Map(data.items.map(i => [i.itemSequence, i.rate]))
  const sourceWord = (src: 'typed' | 'finance' | 'none') =>
    src === 'typed' ? 'typed' : src === 'finance' ? 'confirmed payments' : 'none recorded'
  const s = result.split

  const lineRows: SheetCell[][] = result.lines.map(l => [
    l.itemSequence,
    l.productName ?? '—',
    l.rate,
    l.ordered,
    l.previouslyDispatched,
    l.planned,
    l.remaining,
    rupees(l.orderedPaise),
    rupees(l.plannedPaise),
  ])

  const lotRows: SheetCell[][] = data.lots
    .filter(l => l.status === 'dispatched')
    .map(l => {
      const goods = l.lines.reduce((sum, x) => sum + Math.round(x.quantity * 100) * Math.round((rateOf.get(x.itemSequence) ?? 0) * 100), 0)
      return [`Lot ${l.lotNo}`, dateText(l.dispatchedOn), l.lines.length, Math.round(goods / 100) / 100]
    })
  if (extra.lotLines && Object.values(extra.lotLines).some(q => q > 0)) {
    lotRows.push([
      'This lot (planned)',
      dateText(extra.plannedOn),
      Object.values(extra.lotLines).filter(q => q > 0).length,
      rupees(result.plannedPaise),
    ])
  }

  const notes: string[] = []
  notes.push(`Account = payments into the company bank account (HDFC). Cash = all other payments. The billed part (${result.billingPercent === null ? 'billing % not set' : pct(result.billingPercent)}) and all GST are paid in account; the rest in cash.`)
  if (result.billingMissing) notes.push('No billing percentage is set on the PI or on this plan, so everything is shown as cash and no GST is included.')
  if (s.movedFromAccount.excessPaise > 0) {
    notes.push(`More was paid in account than needed. The extra ${formatPaise(s.movedFromAccount.excessPaise)} is billed: ${formatPaise(s.movedFromAccount.goodsPaise)} of goods (taken off the cash balance) and ${formatPaise(s.movedFromAccount.gstPaise)} of GST.`)
  }
  if (s.balance.cash < 0) notes.push(`${formatPaise(-s.balance.cash)} more has been paid in cash than needed.`)
  if (data.piDiffersFromOrder) notes.push('The Order value was amended after the PI; this sheet uses the PI\'s totals.')
  if (s.awaiting.account > 0 || s.awaiting.cash > 0) {
    notes.push(`Still being checked in Finance and not counted yet: ${formatPaise(s.awaiting.account)} in account, ${formatPaise(s.awaiting.cash)} in cash.`)
  }
  if (data.note) notes.push(data.note)

  return {
    title: `Payment plan — Order ${data.displayNumber}`,
    facts: [
      ['Client', data.clientName ?? '—'],
      ['Date', extra.generatedOn],
      ['PI total before GST', formatPaise(result.totalBeforeGstPaise ?? 0)],
      ['Goods sent so far + this lot', `${result.dispatchSharePercent.toFixed(2)}% of the PI's goods`],
      ['Billing (paid in account)', result.billingPercent === null ? 'Not set' : pct(result.billingPercent)],
      ['Received in account', `${formatPaise(s.received.account)} (${sourceWord(s.receivedSource.account)})`],
      ['Received in cash', `${formatPaise(s.received.cash)} (${sourceWord(s.receivedSource.cash)})`],
    ].map(([label, value]) => ({ label, value })),
    lineColumns: [
      { label: 'Line', kind: 'text' },
      { label: 'Product', kind: 'text' },
      { label: 'Rate', kind: 'money' },
      { label: 'Ordered', kind: 'qty' },
      { label: 'Sent earlier', kind: 'qty' },
      { label: 'This lot', kind: 'qty' },
      { label: 'Still to come', kind: 'qty' },
      { label: 'Goods value', kind: 'money' },
      { label: 'This lot value', kind: 'money' },
    ],
    lineRows,
    lineTotals: ['', 'Total', null, null, null, null, null, rupees(result.orderedValuePaise), rupees(result.plannedPaise)],
    lotColumns: [
      { label: 'Lot', kind: 'text' },
      { label: 'Date', kind: 'text' },
      { label: 'Lines', kind: 'qty' },
      { label: 'Goods value', kind: 'money' },
    ],
    lotRows,
    summary: planSummaryRows(result),
    notes,
  }
}

export function paymentPlanFileName(displayNumber: string, ext: 'xlsx' | 'pdf'): string {
  const safe = displayNumber.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'order'
  return `Payment-plan-${safe}.${ext}`
}
