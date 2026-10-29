// ── The Payment plan as a document ────────────────────────────────────────────
//
// ONE model that the screen, the Excel and the PDF all draw, so a download can
// never say something the screen does not. It decides nothing: every figure
// comes from computePaymentPlan, and this only arranges them, in plain words a
// client can follow (owner, 2026-10-29, mockup v2 approved):
//
//   1. the product table (one row per product, this lot's quantities)
//   2. "How the amount is worked out": one plain table, columns Sent earlier |
//      This lot | Still to come | Whole order, ending in what is needed before
//      this dispatch in bank and in cash (those cells are carried forward)
//   3. "To pay before this dispatch": one table read across as a sum,
//      Goods sent + Advance − Already received = Balance, rows Bank / Cash / Total.
//
// Amounts are shown in whole rupees (the owner's own sheet does so); the
// calculation keeps paise.

import {
  rupees,
  type PlanData,
  type PlanResult,
} from './paymentPlan'

export type SheetCell = string | number | null
export type SheetColumn = { label: string; kind: 'text' | 'qty' | 'money' }

/** One row of "How the amount is worked out": four cells (earlier, this lot, still to come, whole order). */
export type CalcRow = {
  label: string
  /** Paise, or words ("100%", "(when sent)"), or null for an empty cell. */
  cells: (number | string | null)[]
  kind: 'line' | 'sum' | 'gap' | 'needed'
  /** The cells carried into "To pay before this dispatch". */
  carried?: boolean
}

export type PayColumn = { mark: string | null; title: string; sub: string; op: '+' | '−' | '=' | null; balance?: boolean }
export type PayRow = { label: string; cells: number[]; total?: boolean }

export type PaymentPlanSheet = {
  title: string
  subtitle: string
  facts: { label: string; value: string }[]
  lineColumns: SheetColumn[]
  lineRows: SheetCell[][]
  lineTotals: SheetCell[]
  calcColumns: string[]
  calcRows: CalcRow[]
  payColumns: PayColumn[]
  payRows: PayRow[]
  notes: string[]
}

const pct = (n: number) => `${(Math.round(n * 100) / 100).toString()}%`
export const gstRateText = (rate: number) => pct(rate * 100)

/** Paise as whole rupees with Indian grouping, no symbol; a minus sign for negatives. */
export function wholeRupees(paise: number): string {
  const r = Math.round(paise / 100)
  const s = Math.abs(r).toLocaleString('en-IN')
  return r < 0 ? `−${s}` : s
}

/** "How the amount is worked out". */
export function planCalcRows(result: PlanResult): CalcRow[] {
  const e = result.earlier, l = result.lot, p = result.pending
  const four = (pick: (g: typeof e) => number) => [pick(e), pick(l), pick(p), pick(e) + pick(l) + pick(p)]
  const billing = result.billingPercent === null ? 'billing % not set' : pct(result.billingPercent)
  const cashShare = result.billingPercent === null ? '100%' : pct(100 - result.billingPercent)
  const adv = result.split.pending
  const bankNeeded = [e.billed + e.gst, l.billed + l.gst, adv.account]
  const cashNeeded = [e.cash, l.cash, adv.cash]
  return [
    { label: 'Item amount', cells: four(g => g.items), kind: 'line' },
    { label: 'Packing', cells: four(g => g.packing), kind: 'line' },
    { label: 'Fabric', cells: four(g => g.fabric), kind: 'line' },
    { label: 'Transport and other charges (shared by item value)', cells: four(g => g.otherShare), kind: 'line' },
    { label: 'Discount (shared by item value)', cells: four(g => g.discountShare), kind: 'line' },
    { label: 'Value', cells: four(g => g.value), kind: 'sum' },
    { label: '', cells: [null, null, null, null], kind: 'gap' },
    { label: `Billed part (${billing}) — paid in bank`, cells: four(g => g.billed), kind: 'line' },
    { label: `GST ${gstRateText(result.gstRate)} on the billed part — paid in bank`, cells: [e.gst, l.gst, '(when sent)', e.gst + l.gst], kind: 'line' },
    { label: `Cash part (${cashShare})`, cells: four(g => g.cash), kind: 'line' },
    { label: '', cells: [null, null, null, null], kind: 'gap' },
    { label: 'Needed before this dispatch', cells: ['100%', '100%', `${pct(result.pendingPercent)} as advance`, null], kind: 'needed' },
    { label: '— in bank', cells: [...bankNeeded, bankNeeded.reduce((a, b) => a + b, 0)], kind: 'line', carried: true },
    { label: '— in cash', cells: [...cashNeeded, cashNeeded.reduce((a, b) => a + b, 0)], kind: 'line', carried: true },
  ]
}

/** "To pay before this dispatch", read across: 1 + 2 − 3 (+ extra moved) = balance. */
export function planPayTable(result: PlanResult): { columns: PayColumn[]; rows: PayRow[] } {
  const s = result.split
  const m = s.movedFromAccount
  const moved = m.excessPaise > 0
  const columns: PayColumn[] = [
    { mark: '1', title: 'Goods sent', sub: 'earlier + this lot, with GST', op: null },
    { mark: '2', title: 'Advance', sub: `${pct(result.pendingPercent)} of goods still to come`, op: '+' },
    { mark: '3', title: 'Already received', sub: 'confirmed payments', op: '−' },
    ...(moved ? [{ mark: '4', title: 'Extra in bank', sub: 'billed as goods + GST', op: '+' as const }] : []),
    { mark: null, title: 'Balance to pay', sub: 'now', op: '=', balance: true },
  ]
  const goodsBank = s.dispatch.account + s.gst.account
  const goodsCash = s.dispatch.cash
  const row = (label: string, goods: number, advance: number, received: number, extra: number, balance: number, total = false): PayRow =>
    ({ label, cells: [goods, advance, received, ...(moved ? [extra] : []), balance], total })
  return {
    columns,
    rows: [
      row('Bank', goodsBank, s.pending.account, s.received.account, m.excessPaise, s.balance.account),
      row('Cash', goodsCash, s.pending.cash, s.received.cash, -m.goodsPaise, s.balance.cash),
      row('Total', goodsBank + goodsCash, s.pending.total, s.received.total, m.gstPaise, s.balance.total, true),
    ],
  }
}

export function buildPaymentPlanSheet(
  data: PlanData,
  result: PlanResult,
  extra: { lotLines: Record<string, number>; generatedOn: string; plannedOn: string | null },
): PaymentPlanSheet {
  const s = result.split
  const lotNo = (data.lots.find(l => l.status === 'planned')?.lotNo)
    ?? (data.lots.filter(l => l.status === 'dispatched').length + 1)

  const lineRows: SheetCell[][] = result.lines.map(l => [
    l.itemSequence,
    l.productName ?? '—',
    l.ordered,
    l.previouslyDispatched,
    l.planned,
    Math.max(0, l.remaining),
    l.rate,
    rupees(l.plannedPaise),
    l.packingRate,
    rupees(l.plannedPackingPaise),
    l.fabricMetresPerPiece,
    l.plannedFabricMetres,
    l.fabricRate,
    rupees(l.plannedFabricPaise),
    rupees(l.plannedLineTotalPaise),
  ])
  const fabricMetres = Math.round(result.lines.reduce((sum, l) => sum + l.plannedFabricMetres, 0) * 1000) / 1000

  const notes: string[] = []
  notes.push('Bank = payments into the company bank account (HDFC). Cash = all other payments (PNB, Paytm, Canara). Amounts rounded to the rupee.')
  if (result.billingMissing) notes.push('No billing percentage is set on the PI or on this plan, so everything is shown as cash and no GST is included.')
  if (s.movedFromAccount.excessPaise > 0) {
    notes.push(`More was paid in bank than needed. The extra ${wholeRupees(s.movedFromAccount.excessPaise)} is billed: ${wholeRupees(s.movedFromAccount.goodsPaise)} of goods (taken off the cash balance) and ${wholeRupees(s.movedFromAccount.gstPaise)} of GST.`)
  }
  if (s.balance.cash < 0) notes.push(`${wholeRupees(-s.balance.cash)} more has been paid in cash than needed.`)
  if (data.piDiffersFromOrder) notes.push('The Order value was amended after the PI; this sheet uses the PI\'s totals.')
  if (s.awaiting.account > 0 || s.awaiting.cash > 0) {
    notes.push(`Still being checked in Finance and not counted yet: ${wholeRupees(s.awaiting.account)} in bank, ${wholeRupees(s.awaiting.cash)} in cash.`)
  }
  if (data.note) notes.push(data.note)

  const billing = result.billingPercent === null ? 'billing not set' : `Billing ${pct(result.billingPercent)} in bank, rest in cash`
  const who = data.kind === 'bdpi' && data.oldOrderNo ? `Old order ${data.oldOrderNo}` : null
  const pay = planPayTable(result)

  return {
    title: `Payment plan — ${data.kind === 'bdpi' ? '' : 'Order '}${data.displayNumber}`,
    subtitle: [who, data.clientName, `Lot ${lotNo}`, extra.generatedOn, billing,
      `Advance on goods still to come ${pct(result.pendingPercent)}`].filter(Boolean).join(' · '),
    facts: [
      ['Client', data.clientName ?? '—'],
      ['Date', extra.generatedOn],
      ['Billing (paid in bank)', result.billingPercent === null ? 'Not set' : pct(result.billingPercent)],
    ].map(([label, value]) => ({ label, value })),
    lineColumns: [
      { label: 'Code', kind: 'text' },
      { label: 'Item', kind: 'text' },
      { label: 'Total qty', kind: 'qty' },
      { label: 'Sent earlier', kind: 'qty' },
      { label: 'This lot', kind: 'qty' },
      { label: 'Still to come', kind: 'qty' },
      { label: 'Unit price', kind: 'money' },
      { label: 'Item amount', kind: 'money' },
      { label: 'Pkg rate', kind: 'money' },
      { label: 'Pkg amount', kind: 'money' },
      { label: 'Fabric m/pc', kind: 'qty' },
      { label: 'Fabric m', kind: 'qty' },
      { label: 'Fab rate', kind: 'money' },
      { label: 'Fab amount', kind: 'money' },
      { label: 'Line total', kind: 'money' },
    ],
    lineRows,
    lineTotals: ['', 'This lot', null, null, null, null, null, rupees(result.lot.items), null, rupees(result.lot.packing),
      null, fabricMetres, null, rupees(result.lot.fabric), rupees(result.lot.items + result.lot.packing + result.lot.fabric)],
    calcColumns: ['Sent earlier', 'This lot', 'Still to come', 'Whole order'],
    calcRows: planCalcRows(result),
    payColumns: pay.columns,
    payRows: pay.rows,
    notes,
  }
}

export function paymentPlanFileName(displayNumber: string, ext: 'xlsx' | 'pdf'): string {
  const safe = displayNumber.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'order'
  return `Payment-plan-${safe}.${ext}`
}
