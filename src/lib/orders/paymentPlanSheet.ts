// ── The Payment plan as a document ────────────────────────────────────────────
//
// ONE model that the Excel and the PDF both draw, so a download can never say
// something the screen does not. It decides nothing: every figure comes from
// computePaymentPlan, and this only arranges them into labelled blocks.

import {
  formatPaise,
  rupees,
  type PlanData,
  type PlanResult,
} from './paymentPlan'

export type SheetCell = string | number | null
export type SheetColumn = { label: string; kind: 'text' | 'qty' | 'money' }

export type PaymentPlanSheet = {
  title: string
  facts: { label: string; value: string }[]
  lineColumns: SheetColumn[]
  lineRows: SheetCell[][]
  lineTotals: SheetCell[]
  lotColumns: SheetColumn[]
  lotRows: SheetCell[][]
  summary: { label: string; value: number; strong?: boolean }[]
  notes: string[]
}

const dateText = (iso: string | null) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}-${m}-${y}` : iso
}

export function buildPaymentPlanSheet(
  data: PlanData,
  result: PlanResult,
  extra: { lotLines: Record<string, number>; generatedOn: string; plannedOn: string | null },
): PaymentPlanSheet {
  const rateOf = new Map(data.items.map(i => [i.itemSequence, i.rate]))
  const advanceWord = result.advanceSource === 'typed'
    ? 'typed by you'
    : result.advanceSource === 'finance' ? 'verified payments in Finance' : 'none found in Finance'

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
      const goods = l.lines.reduce((s, x) => s + Math.round(x.quantity * 100) * Math.round((rateOf.get(x.itemSequence) ?? 0) * 100), 0)
      return [
        `Lot ${l.lotNo}`,
        dateText(l.dispatchedOn),
        l.lines.length,
        Math.round(goods / 100) / 100,
      ]
    })
  if (extra.lotLines && Object.values(extra.lotLines).some(q => q > 0)) {
    lotRows.push([
      'Planned lot',
      dateText(extra.plannedOn),
      Object.values(extra.lotLines).filter(q => q > 0).length,
      rupees(result.plannedPaise),
    ])
  }

  const notes: string[] = []
  if (result.billingMissing) notes.push('No billing percentage is set on the PI or on this plan, so GST is not included.')
  if (data.piDiffersFromOrder) notes.push('The Order value was amended after the PI; this sheet uses the PI\'s totals.')
  if (result.advanceSource === 'none') notes.push('No verified payment was found in Finance and no advance was typed, so the advance is taken as ₹0.00.')
  if (result.financeAwaitingPaise > 0) {
    notes.push(`${formatPaise(result.financeAwaitingPaise)} is recorded in Finance but not yet verified; it is not counted unless typed as the advance.`)
  }
  if (data.note) notes.push(data.note)

  return {
    title: `Payment plan — Order ${data.displayNumber}`,
    facts: [
      ['Client', data.clientName ?? '—'],
      ['Date', extra.generatedOn],
      ['Total before GST (PI)', formatPaise(result.totalBeforeGstPaise ?? 0)],
      ['Goods leaving (to date + this lot)', `${result.dispatchSharePercent.toFixed(2)}% of the PI's goods`],
      ['Pending share required', `${result.pendingPercent}%`],
      ['Billing percentage', result.billingPercent === null ? 'Not set' : `${result.billingPercent}%`],
      ['GST rate', `${(result.gstRate * 100).toFixed(2).replace(/\.?0+$/, '')}%`],
      ['Advance received', `${formatPaise(result.advancePaise)} (${advanceWord})`],
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
    summary: [
      { label: 'Dispatched goods with their share of charges (paid in full)', value: rupees(result.dispatchAmountPaise) },
      { label: `GST on the billed part (${result.billingPercent ?? 0}% x ${(result.gstRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`, value: rupees(result.gstOnDispatchPaise) },
      { label: `${result.pendingPercent}% of goods still to come, charges included (no GST)`, value: rupees(result.pendingShareAmountPaise) },
      { label: 'Total required before this dispatch', value: rupees(result.requiredPaise), strong: true },
      { label: 'Advance received', value: rupees(result.advancePaise) },
      {
        label: result.toCollectPaise >= 0 ? 'Still to collect from the client' : 'Surplus already paid',
        value: rupees(Math.abs(result.toCollectPaise)),
        strong: true,
      },
    ],
    notes,
  }
}

export function paymentPlanFileName(displayNumber: string, ext: 'xlsx' | 'pdf'): string {
  const safe = displayNumber.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'order'
  return `Payment-plan-${safe}.${ext}`
}
